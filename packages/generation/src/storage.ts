import type { BetterAuthOptions } from "@better-auth/core";
import type { DBAdapter, Where } from "@better-auth/core/db/adapter";
import { canonical, generationError } from "./primitives";
import type {
	GenerationAttempt,
	GenerationJobRow,
	StoredGenerationAsset,
} from "./types";

export type GenerationDB = Pick<
	DBAdapter,
	"findOne" | "findMany" | "create" | "updateMany"
>;
export async function findJob(
	db: GenerationDB,
	jobId: string,
	userId?: string,
) {
	const job = await db.findOne<GenerationJobRow>({
		model: "generationJob",
		where: [
			{ field: "id", value: jobId },
			...(userId === undefined ? [] : [{ field: "userId", value: userId }]),
		],
	});
	if (!job) throw generationError("NOT_FOUND", "GENERATION_NOT_FOUND");
	return job;
}
export async function findAttempt(db: GenerationDB, jobId: string) {
	const attempt = await db.findOne<GenerationAttempt>({
		model: "generationAttempt",
		where: [{ field: "jobId", value: jobId }],
	});
	if (!attempt) throw new Error("Generation attempt is missing");
	return attempt;
}
export function listAssets(db: GenerationDB, jobId: string) {
	return db.findMany<StoredGenerationAsset>({
		model: "generationAsset",
		where: [{ field: "jobId", value: jobId }],
		limit: 16,
		sortBy: { field: "position", direction: "asc" },
	});
}
export async function recordEvent(
	db: GenerationDB,
	jobId: string,
	kind: string,
	payload: object,
	eventKey: string = crypto.randomUUID(),
) {
	return db.create({
		model: "generationEvent",
		data: {
			jobId,
			eventKey,
			kind,
			payload: canonical(payload),
			createdAt: new Date(),
		},
	});
}
export function leaseWhere(job: GenerationJobRow): Where[] {
	return [
		{ field: "id", value: job.id },
		{ field: "revision", value: job.revision },
		{ field: "leaseToken", value: job.leaseToken },
		{ field: "leaseExpiresAt", value: new Date(), operator: "gt" },
	];
}
/** Commit state and evidence together; expired workers cannot overwrite results. */
export async function commitJob<Options extends BetterAuthOptions>(
	adapter: DBAdapter<Options>,
	job: GenerationJobRow,
	update: Partial<GenerationJobRow>,
	kind: string,
	attemptUpdate?: Partial<GenerationAttempt>,
	release = true,
) {
	return adapter.transaction(async (db) => {
		const changes = {
			...update,
			revision: job.revision + 1,
			updatedAt: new Date(),
			...(release ? { leaseToken: null, leaseExpiresAt: new Date(0) } : {}),
		};
		const count = await db.updateMany({
			model: "generationJob",
			where: leaseWhere(job),
			update: changes,
		});
		if (count !== 1) throw generationError("CONFLICT", "GENERATION_LEASE_LOST");
		if (attemptUpdate)
			await db.updateMany({
				model: "generationAttempt",
				where: [{ field: "jobId", value: job.id }],
				update: attemptUpdate,
			});
		await recordEvent(db, job.id, kind, {
			status: update.status ?? job.status,
			deliveryStatus: update.deliveryStatus ?? job.deliveryStatus,
			error: update.lastError ?? null,
		});
		return { ...job, ...changes };
	});
}
