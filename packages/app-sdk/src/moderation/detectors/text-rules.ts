import { moderationError } from "../primitives";
import type { ModerationDetector } from "../types";

/** Exact literal matching only; this detector never claims semantic coverage. */
export function createTextRulesDetector(options: {
	id?: string;
	version: string;
	literal_terms: { term: string; category: string; case_sensitive?: boolean }[];
}): ModerationDetector {
	if (
		!options.version ||
		!options.literal_terms.length ||
		options.literal_terms.some(
			(rule) => !rule.term.trim() || !rule.category.trim(),
		)
	)
		throw moderationError(
			"INVALID_DETECTOR",
			"Literal rules require terms, categories and a version",
		);
	const terms = options.literal_terms.map((rule) => ({ ...rule }));
	return {
		id: options.id ?? "text-rules",
		version: options.version,
		layer: "rules",
		capabilities: [...new Set(terms.map((rule) => rule.category))].map(
			(category) => ({
				modality: "text",
				category,
				inspection_scope: "text.rules",
			}),
		),
		async check({ requested_checks, signal }) {
			return requested_checks.map(({ requested_check_id, item, rule }) => {
				signal.throwIfAborted();
				const applicable = terms.filter(
					(entry) => entry.category === rule.category,
				);
				const supported =
					item.modality === "text" &&
					rule.minimum_scope === "text.rules" &&
					applicable.length > 0;
				const flagged =
					supported &&
					item.modality === "text" &&
					applicable.some((entry) =>
						entry.case_sensitive
							? item.text.includes(entry.term)
							: item.text.toLowerCase().includes(entry.term.toLowerCase()),
					);
				return {
					requested_check_id,
					coverage: supported ? "checked" : "unsupported",
					flagged,
					score: null,
					reason_code: supported
						? flagged
							? "LITERAL_MATCH"
							: "LITERAL_CLEAR"
						: "DETECTOR_UNSUPPORTED",
				};
			});
		},
	};
}
