import { bounded, canonical, digest, moderationError } from "./primitives";
import type {
	AttemptState,
	Controls,
	EffectivePolicy,
	ModerationOptions,
	ModerationTransaction,
	Permission,
	StoredRecord,
	TrustedContext,
} from "./types";
import { contextSchema, controlsSchema, effectivePolicy } from "./validation";

export interface Prepared {
	policy: EffectivePolicy;
	controls: Controls;
	capability_snapshot_id: string;
}
export interface CommandState {
	fingerprint: string;
	status: "running" | "done";
	lease_until: string;
	result: object | null;
}

/** Shared command boundary: authorization, snapshots and transactional idempotency. */
export function createModerationRuntime(options: ModerationOptions) {
	if (
		!Number.isSafeInteger(options.boundary_timeout_ms) ||
		options.boundary_timeout_ms <= 0 ||
		options.boundary_timeout_ms > 2_147_483_647 ||
		options.evidence_secret.length < 32
	) {
		throw moderationError(
			"INVALID_CONFIGURATION",
			"Moderation requires a positive boundary timeout and a random server evidence secret",
		);
	}
	const key = crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(options.evidence_secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	async function opaque(tenant_id: string, value: unknown) {
		const bytes = await crypto.subtle.sign(
			"HMAC",
			await key,
			new TextEncoder().encode(canonical([tenant_id, value])),
		);
		return Array.from(new Uint8Array(bytes), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
	}
	const fingerprint = (context: TrustedContext, value: unknown) =>
		opaque(context.tenant_id, [context.subject_id, value]);
	async function prepare(
		context: TrustedContext,
		permission: Permission,
	): Promise<Prepared> {
		contextSchema.parse(context);
		await bounded(options.boundary_timeout_ms, () =>
			options.authorize(context, permission),
		);
		const resolved = await bounded(options.boundary_timeout_ms, () =>
			options.resolvePolicy(context),
		);
		const policy = await effectivePolicy(resolved);
		const controls = controlsSchema.parse(
			await bounded(options.boundary_timeout_ms, () =>
				options.resolveControls(context),
			),
		);
		const matrix = options.detectors.map((detector) => ({
			id: detector.id,
			version: detector.version,
			layer: detector.layer,
			capabilities: detector.capabilities,
			enabled: !controls.disabled_detectors.includes(detector.id),
		}));
		return {
			policy,
			controls,
			capability_snapshot_id: await digest({ matrix, controls }),
		};
	}
	async function snapshots(tx: ModerationTransaction, prepared: Prepared) {
		for (const [kind, id, data] of [
			["policy", prepared.policy.version, prepared.policy],
			[
				"capability",
				prepared.capability_snapshot_id,
				{
					controls: prepared.controls,
					detectors: options.detectors.map(
						({ id, version, layer, capabilities }) => ({
							id,
							version,
							layer,
							capabilities,
						}),
					),
				},
			],
		] as const) {
			const existing = await tx.get(kind, id);
			if (existing && canonical(existing.data) !== canonical(data))
				throw moderationError(
					"SNAPSHOT_CONFLICT",
					"A moderation version cannot be reused with different data",
				);
			if (!existing)
				await tx.insert({
					kind,
					key: id,
					subject_id: null,
					attempt_id: null,
					data,
				});
		}
	}
	async function attempt(
		tx: ModerationTransaction,
		context: TrustedContext,
		id: string,
	): Promise<StoredRecord<AttemptState>> {
		const stored = await tx.get<AttemptState>("attempt", id);
		if (!stored || stored.data.subject_id !== context.subject_id)
			throw moderationError("NOT_FOUND", "Moderation attempt not found");
		return stored;
	}
	async function event(
		tx: ModerationTransaction,
		context: TrustedContext,
		key: string,
		type: string,
		payload: object,
		attempt_id: string | null = null,
	) {
		return tx.insert({
			kind: "event",
			key,
			subject_id: context.subject_id,
			attempt_id,
			data: {
				type,
				actor_id: context.actor_id,
				occurred_at: new Date().toISOString(),
				...payload,
			},
		});
	}
	async function command<T extends object>(
		context: TrustedContext,
		method: string,
		idempotency_key: string,
		input: unknown,
		permission: Permission,
		work: (tx: ModerationTransaction, prepared: Prepared) => Promise<T>,
	): Promise<T> {
		const prepared = await prepare(context, permission);
		const hash = await fingerprint(context, input);
		return options.storage.transaction(context.tenant_id, async (tx) => {
			const name = `${method}:${idempotency_key}`;
			const previous = await tx.get<CommandState>("command", name);
			if (previous) {
				if (
					previous.data.fingerprint !== hash ||
					previous.subject_id !== context.subject_id
				)
					throw moderationError(
						"IDEMPOTENCY_CONFLICT",
						"Moderation command key already used",
					);
				if (previous.data.status === "done" && previous.data.result)
					return previous.data.result as T;
				throw moderationError(
					"IN_PROGRESS",
					"Moderation command is still running",
				);
			}
			await snapshots(tx, prepared);
			const result = await work(tx, prepared);
			await tx.insert({
				kind: "command",
				key: name,
				subject_id: context.subject_id,
				attempt_id: null,
				data: {
					fingerprint: hash,
					status: "done",
					lease_until: new Date().toISOString(),
					result,
				} satisfies CommandState,
			});
			return result;
		});
	}
	return {
		options,
		prepare,
		snapshots,
		attempt,
		event,
		command,
		fingerprint,
		opaque,
	};
}
export type ModerationRuntime = ReturnType<typeof createModerationRuntime>;
