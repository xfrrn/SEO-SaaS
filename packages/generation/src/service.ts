import type { BetterAuthOptions } from "@better-auth/core";
import type { DBAdapter } from "@better-auth/core/db/adapter";
import * as z from "zod";
import {
	bounded,
	canonical,
	digest,
	generationError,
	publicJob,
} from "./primitives";
import { createGenerationRuntime } from "./runtime";
import { findAttempt, findJob, listAssets, recordEvent } from "./storage";
import type {
	GenerationAttempt,
	GenerationJobRow,
	GenerationOptions,
} from "./types";
import {
	createBody,
	detailQuery,
	identifier,
	listQuery,
	notificationBody,
	parametersSchema,
	reconcileBody,
} from "./validation";
import { createGenerationWorker } from "./worker";

/** Trusted server service; derive userId from the authenticated host, never a body. */
export function createGenerationService<Options extends BetterAuthOptions>(
	adapter: DBAdapter<Options>,
	options: GenerationOptions,
) {
	const runtime = createGenerationRuntime(adapter, options);
	const { models, snapshot, limits } = runtime;
	async function create(userId: string, input: z.input<typeof createBody>) {
		identifier.parse(userId);
		const request = createBody.parse(input);
		const raw = canonical(request);
		if (new TextEncoder().encode(raw).length > 128 * 1024)
			throw generationError("BAD_REQUEST", "GENERATION_REQUEST_TOO_LARGE");
		const requestHash = await digest(raw);
		const existing = () =>
			adapter.findOne<GenerationJobRow>({
				model: "generationJob",
				where: [
					{ field: "userId", value: userId },
					{ field: "idempotencyKey", value: request.idempotencyKey },
				],
			});
		function replay(job: GenerationJobRow) {
			if (job.requestHash !== requestHash)
				throw generationError("CONFLICT", "GENERATION_IDEMPOTENCY_CONFLICT");
			return { job: publicJob(job) };
		}
		const previous = await existing();
		if (previous) return replay(previous);
		const model = models.get(request.model);
		if (
			!model ||
			!model.modes.includes(request.mode) ||
			request.inputAssets.length > model.maxInputAssets ||
			(request.mode.startsWith("image-")
				? request.inputAssets.length === 0
				: request.inputAssets.length !== 0)
		)
			throw generationError(
				"BAD_REQUEST",
				"GENERATION_MODEL_INPUT_UNSUPPORTED",
			);
		const parsed = model.parameters.safeParse(request.parameters);
		if (!parsed.success)
			throw generationError("BAD_REQUEST", "GENERATION_PARAMETERS_INVALID");
		request.parameters = parametersSchema.parse(parsed.data);
		try {
			return await adapter.transaction(async (db) => {
				const now = new Date();
				const job = await db.create<
					Omit<GenerationJobRow, "id">,
					GenerationJobRow
				>({
					model: "generationJob",
					data: {
						userId,
						modelId: model.id,
						modelSnapshot: canonical(snapshot(model.id)),
						request: canonical(request),
						requestHash,
						idempotencyKey: request.idempotencyKey,
						status: "queued",
						deliveryStatus: "pending",
						revision: 0,
						cancelRequested: false,
						lastError: null,
						nextRunAt: now,
						leaseToken: null,
						leaseExpiresAt: new Date(0),
						expiresAt: new Date(now.getTime() + limits.taskTimeoutMs),
						createdAt: now,
						updatedAt: now,
					},
				});
				await db.create<Omit<GenerationAttempt, "id">>({
					model: "generationAttempt",
					data: {
						jobId: job.id,
						providerId: model.providerId,
						providerTaskId: null,
						providerTaskKey: `pending:${job.id}`,
						cancelAttempted: false,
						outputCount: 0,
						result: null,
						createdAt: now,
					},
				});
				await recordEvent(db, job.id, "created", {
					modelId: model.id,
					version: model.version,
				});
				return { job: publicJob(job) };
			});
		} catch (error) {
			const committed = await existing();
			if (committed) return replay(committed);
			throw error;
		}
	}
	async function get(userId: string, jobId: string) {
		detailQuery.parse({ jobId });
		const job = await findJob(adapter, jobId, userId);
		let assets =
			job.deliveryStatus === "ready" ? await listAssets(adapter, job.id) : [];
		if (assets.length && options.policy) {
			const attempt = await findAttempt(adapter, job.id);
			const signal = AbortSignal.timeout(limits.operationTimeoutMs);
			if (
				(await bounded(signal, () =>
					options.policy!.authorizeDelivery({
						...runtime.context(job, attempt, signal),
						assets,
					}),
				)) !== true
			) {
				assets = [];
				return {
					job: { ...publicJob(job), deliveryStatus: "blocked" as const },
					assets,
				};
			}
		}
		return { job: publicJob(job), assets };
	}
	async function list(userId: string, input: z.input<typeof listQuery> = {}) {
		const query = listQuery.parse(input);
		const where = [{ field: "userId", value: userId }];
		const [jobs, total] = await Promise.all([
			adapter.findMany<GenerationJobRow>({
				model: "generationJob",
				where,
				...query,
				sortBy: { field: "createdAt", direction: "desc" },
			}),
			adapter.count({ model: "generationJob", where }),
		]);
		return { jobs: jobs.map(publicJob), total };
	}
	async function cancel(userId: string, jobId: string) {
		detailQuery.parse({ jobId });
		await adapter.transaction(async (db) => {
			const job = await findJob(db, jobId, userId);
			if (
				["succeeded", "failed", "cancelled"].includes(job.status) ||
				job.cancelRequested
			)
				return;
			const queued = job.status === "queued";
			const count = await db.updateMany({
				model: "generationJob",
				where: [
					{ field: "id", value: job.id },
					{ field: "revision", value: job.revision },
				],
				update: {
					cancelRequested: true,
					nextRunAt: queued || job.nextRunAt === null ? null : new Date(),
					updatedAt: new Date(),
					...(queued
						? {
								status: "cancelled",
								revision: job.revision + 1,
								leaseToken: null,
								leaseExpiresAt: new Date(0),
							}
						: {}),
				},
			});
			if (count !== 1)
				throw generationError("CONFLICT", "GENERATION_STATE_CONFLICT");
			await recordEvent(db, job.id, "cancel_requested", {});
		});
		return { job: publicJob(await findJob(adapter, jobId, userId)) };
	}
	async function notify(input: z.input<typeof notificationBody>) {
		const notice = notificationBody.parse(input);
		const taskKey = await digest(canonical([notice.providerId, notice.taskId]));
		const attempt = await adapter.findOne<GenerationAttempt>({
			model: "generationAttempt",
			where: [{ field: "providerTaskKey", value: taskKey }],
		});
		if (!attempt) throw generationError("NOT_FOUND", "GENERATION_NOT_FOUND");
		const eventKey = await digest(
			canonical([notice.providerId, notice.eventId]),
		);
		const previous = () =>
			adapter.findOne<{ jobId: string }>({
				model: "generationEvent",
				where: [{ field: "eventKey", value: eventKey }],
			});
		function replay(event: { jobId: string }) {
			if (event.jobId !== attempt!.jobId)
				throw generationError("CONFLICT", "GENERATION_EVENT_CONFLICT");
			return { accepted: true };
		}
		const event = await previous();
		if (event) return replay(event);
		try {
			return await adapter.transaction(async (db) => {
				const job = await findJob(db, attempt.jobId);
				await recordEvent(db, job.id, "provider_notification", {}, eventKey);
				if (job.status === "running")
					await db.updateMany({
						model: "generationJob",
						where: [
							{ field: "id", value: job.id },
							{ field: "status", value: "running" },
						],
						update: { nextRunAt: new Date() },
					});
				return { accepted: true };
			});
		} catch (error) {
			const committed = await previous();
			if (committed) return replay(committed);
			throw error;
		}
	}
	async function reconcile(input: z.input<typeof reconcileBody>) {
		const request = reconcileBody.parse(input);
		return adapter.transaction(async (db) => {
			const job = await findJob(db, request.jobId);
			if (
				job.status !== "needs_reconciliation" ||
				job.revision !== request.expectedRevision
			)
				throw generationError("CONFLICT", "GENERATION_STATE_CONFLICT");
			const attempt = await findAttempt(db, job.id);
			if (request.outcome === "resume" && attempt.outputCount < 1)
				throw generationError("BAD_REQUEST", "GENERATION_RESULT_UNAVAILABLE");
			if (
				request.outcome === "running" &&
				!runtime.providers.get(attempt.providerId)?.poll
			)
				throw generationError("BAD_REQUEST", "GENERATION_POLL_UNSUPPORTED");
			const count = await db.updateMany({
				model: "generationJob",
				where: [
					{ field: "id", value: job.id },
					{ field: "revision", value: job.revision },
				],
				update: {
					status: request.outcome === "resume" ? "succeeded" : request.outcome,
					revision: job.revision + 1,
					lastError:
						request.outcome === "failed" ? "GENERATION_CONFIRMED_FAILED" : null,
					nextRunAt: request.outcome === "failed" ? null : new Date(),
					expiresAt: new Date(Date.now() + limits.taskTimeoutMs),
					updatedAt: new Date(),
				},
			});
			if (count !== 1)
				throw generationError("CONFLICT", "GENERATION_STATE_CONFLICT");
			if (request.taskId)
				await db.updateMany({
					model: "generationAttempt",
					where: [{ field: "id", value: attempt.id }],
					update: {
						providerTaskId: request.taskId,
						providerTaskKey: await digest(
							canonical([attempt.providerId, request.taskId]),
						),
					},
				});
			await recordEvent(db, job.id, "reconciled", { outcome: request.outcome });
			return { job: publicJob(await findJob(db, job.id)) };
		});
	}
	return {
		create,
		get,
		list,
		cancel,
		notify,
		reconcile,
		async inspect(jobId: string) {
			const job = await findJob(adapter, detailQuery.parse({ jobId }).jobId);
			const attempt = await findAttempt(adapter, job.id);
			return {
				job: publicJob(job),
				revision: job.revision,
				attemptId: attempt.id,
				providerId: attempt.providerId,
				providerTaskId: attempt.providerTaskId,
			};
		},
		models: () => ({
			models: [...models.values()].map((model) => ({
				...snapshot(model.id),
				parameters: z.toJSONSchema(model.parameters, { io: "input" }),
				cancelSupported: !!runtime.providers.get(model.providerId)?.cancel,
			})),
		}),
		run: createGenerationWorker(runtime),
	};
}
