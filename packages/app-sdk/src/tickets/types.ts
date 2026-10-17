/** Persisted customer feedback and its current processing state. */
export interface SupportTicket {
	id: string;
	userId: string;
	title: string;
	content: string;
	status: TicketStatus;
	revision: number;
	idempotencyKey: string;
	createdAt: Date;
	updatedAt: Date;
}

/** Public processing states; only administrators may change them. */
export type TicketStatus = "open" | "in_progress" | "closed";

/** Immutable replies and status changes, ordered within their ticket. */
export interface TicketEntry {
	id: string;
	ticketId: string;
	authorId: string;
	authorRole: "user" | "admin";
	kind: "reply" | "status";
	content: string | null;
	status: TicketStatus | null;
	sequence: number;
	idempotencyKey: string;
	createdAt: Date;
}
