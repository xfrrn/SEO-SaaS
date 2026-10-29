import type { ModerationStorage } from "./storage-types";
import type {
	ConsentDeclaration,
	ContentItem,
	Controls,
	EnforcementAction,
	ModerationDetector,
	Operation,
	PlatformPolicy,
	ResolvedAbuseContext,
	TenantPolicy,
	TrustedContext,
} from "./types";

export type Permission =
	| "check"
	| "evaluate"
	| "authorize"
	| "record"
	| "review"
	| "consent"
	| "verify_consent"
	| "worker"
	| "export"
	| "cleanup"
	| "capabilities";
/** Hosts supply trusted identity, immutable media and idempotent side effects. */
export interface ModerationOptions {
	storage: ModerationStorage;
	detectors: ModerationDetector[];
	boundary_timeout_ms: number;
	/** Random server-only HMAC secret, at least 32 characters; never persisted. */
	evidence_secret: string;
	/**
	 * Authorize the trusted context for a permission. Throw an error to deny, or
	 * return `false`; a `false` return is treated as a denial, never as success.
	 */
	authorize(
		context: TrustedContext,
		permission: Permission,
	): Promise<void | false>;
	resolvePolicy(
		context: TrustedContext,
	): Promise<{ platform: PlatformPolicy; tenant?: TenantPolicy }>;
	resolveControls(context: TrustedContext): Promise<Controls>;
	resolveRestrictedSignal(
		context: TrustedContext,
		items: ContentItem[],
		signal: AbortSignal,
	): Promise<{
		status: "none" | "suspected" | "confirmed";
		source: string;
		evidence_ref: string | null;
	}>;
	handoffRestricted?: (input: {
		context: TrustedContext;
		items: ContentItem[];
		idempotency_key: string;
		evidence_ref: string | null;
		signal: AbortSignal;
	}) => Promise<{ case_ref: string }>;
	resolveAbuseContext?: (
		context: TrustedContext,
		attempt_id: string,
		signal: AbortSignal,
	) => Promise<ResolvedAbuseContext>;
	executeAction?: (
		input: EnforcementAction & { context: TrustedContext; signal: AbortSignal },
	) => Promise<{
		status: "succeeded" | "failed" | "pending";
		reason_code: string;
	}>;
	erase?: (input: {
		context: TrustedContext;
		cleanup_id: string;
		resource_ref: string;
		signal: AbortSignal;
	}) => Promise<void | false>;
	/**
	 * Host verifies asset ownership, revision, current context and private
	 * references. Throw an error to reject, or return `false`.
	 */
	validateContent(
		context: TrustedContext,
		items: ContentItem[],
		content_revision: string,
		context_digest: string,
	): Promise<void | false>;
	validateConsent?: (
		context: TrustedContext,
		consent: ConsentDeclaration,
		assets: { item_id: string; revision: string; asset_ref: string }[],
		operation: Operation,
	) => Promise<void | false>;
}
