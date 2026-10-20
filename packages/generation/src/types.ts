import type * as z from "zod";

/** Operations are advertised per model, never inferred from a provider's name. */
export type GenerationMode =
	| "text-to-image"
	| "image-to-image"
	| "text-to-video"
	| "image-to-video";
export type GenerationStatus =
	| "queued"
	| "submitting"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "needs_reconciliation";
export type DeliveryStatus = "pending" | "ready" | "blocked" | "review";
export type Parameters = Record<string, z.infer<ReturnType<typeof z.json>>>;

/** Stable server configuration; changing a model requires a new version. */
export interface GenerationModel {
	id: string;
	providerId: string;
	model: string;
	version: string;
	kind: "image" | "video";
	modes: GenerationMode[];
	maxInputAssets: number;
	parameters: z.ZodType<Parameters>;
}
export type ModelSnapshot = Omit<GenerationModel, "parameters">;

/** Assets are application-owned references, never arbitrary customer URLs. */
export interface GenerationRequest {
	model: string;
	mode: GenerationMode;
	prompt: string;
	inputAssets: string[];
	parameters: Parameters;
	idempotencyKey: string;
}
export interface GenerationInput {
	bytes: Uint8Array;
	mediaType: string;
	/** Optional short-lived URL, resolved and authorized by the host. */
	url?: string;
}
export interface GenerationOutput {
	mediaType: string;
	url?: string;
	base64?: string;
	width?: number;
	height?: number;
	durationSeconds?: number;
}
export type ProviderResult =
	| { status: "running"; taskId: string }
	| {
			status: "succeeded";
			taskId?: string;
			outputs: GenerationOutput[];
			usage?: Parameters;
	  }
	| {
			status: "failed" | "cancelled";
			taskId?: string;
			code?: "policy_refused" | "provider_failed";
	  };
export interface ProviderCall {
	model: ModelSnapshot;
	request: GenerationRequest;
	userId: string;
	submissionKey: string;
	signal: AbortSignal;
}
export interface ProviderPoll extends ProviderCall {
	taskId: string;
}

/** Implement the same contract for an additional official or authorized API. */
export interface GenerationProvider {
	id: string;
	submit(
		input: ProviderCall & { inputs: GenerationInput[] },
	): Promise<ProviderResult>;
	poll?(input: ProviderPoll): Promise<ProviderResult>;
	cancel?(input: ProviderPoll): Promise<ProviderResult>;
	/** Must validate destination URLs and restrict forwarding of credentials. */
	readOutput?(output: GenerationOutput, signal: AbortSignal): Promise<Response>;
}
export interface StoredGenerationAsset {
	id: string;
	jobId: string;
	attemptId: string;
	position: number;
	ref: string;
	mediaType: string;
	size: number;
	width: number | null;
	height: number | null;
	durationSeconds: number | null;
	createdAt: Date;
}
/** Public task details exclude native task IDs, temporary URLs and staged bytes. */
export interface GenerationJob {
	id: string;
	model: string;
	mode: GenerationMode;
	status: GenerationStatus;
	deliveryStatus: DeliveryStatus;
	cancelRequested: boolean;
	lastError: string | null;
	createdAt: Date;
	updatedAt: Date;
}
export interface GenerationJobRow {
	id: string;
	userId: string;
	modelId: string;
	modelSnapshot: string;
	request: string;
	requestHash: string;
	idempotencyKey: string;
	status: GenerationStatus;
	deliveryStatus: DeliveryStatus;
	revision: number;
	cancelRequested: boolean;
	lastError: string | null;
	nextRunAt: Date | null;
	leaseToken: string | null;
	leaseExpiresAt: Date;
	expiresAt: Date;
	createdAt: Date;
	updatedAt: Date;
}
export interface GenerationAttempt {
	id: string;
	jobId: string;
	providerId: string;
	providerTaskId: string | null;
	providerTaskKey: string;
	cancelAttempted: boolean;
	outputCount: number;
	result: string | null;
	createdAt: Date;
}
export interface PolicyContext {
	jobId: string;
	attemptId: string;
	userId: string;
	request: GenerationRequest;
	signal: AbortSignal;
}
export type PolicyDecision = "allow" | "block" | "review";

/** All policy callbacks run on the server; bridge these to the moderation plugin. */
export interface GenerationPolicy {
	beforeGenerate(
		input: PolicyContext & { inputs: GenerationInput[] },
	): Promise<PolicyDecision>;
	beforeDeliver(
		input: PolicyContext & { assets: StoredGenerationAsset[] },
	): Promise<PolicyDecision>;
	authorizeDelivery(
		input: PolicyContext & { assets: StoredGenerationAsset[] },
	): Promise<boolean>;
}
/** Host-owned private storage. put must atomically replace/replay the same key. */
export interface GenerationAssetStore {
	readInput(input: {
		userId: string;
		ref: string;
		signal: AbortSignal;
	}): Promise<GenerationInput>;
	put(input: {
		key: string;
		userId: string;
		mediaType: string;
		body: ReadableStream<Uint8Array>;
		signal: AbortSignal;
	}): Promise<{ ref: string }>;
}
export interface GenerationLimits {
	operationTimeoutMs: number;
	leaseMs: number;
	pollIntervalMs: number;
	taskTimeoutMs: number;
	batchSize: number;
	maxInputBytes: number;
	maxOutputBytes: number;
	maxResultBytes: number;
}
/** Credentials belong only to configured providers; no HTTP service starts here. */
export interface GenerationOptions {
	providers: GenerationProvider[];
	models: GenerationModel[];
	assets: GenerationAssetStore;
	policy?: GenerationPolicy;
	limits?: Partial<GenerationLimits>;
}
