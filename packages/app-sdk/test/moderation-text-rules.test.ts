import { describe, expect, it } from "vitest";
import { runChecks } from "../src/moderation/detection";
import { createTextRulesDetector } from "../src/moderation/detectors/text-rules";
import type {
	ContentItem,
	ModerationDetector,
	PolicyRule,
} from "../src/moderation/types";

const text: ContentItem = {
	item_id: "prompt",
	field: "prompt",
	revision: "1",
	modality: "text",
	text: "ordinary text",
};
function rule(overrides: Partial<PolicyRule>): PolicyRule {
	return {
		id: "rule",
		category: "sexual",
		layer: "rules",
		stages: ["prompt"],
		modalities: ["text"],
		minimum_scope: "text.rules",
		required: true,
		mode: "enforce",
		detector_ids: ["text-rules"],
		threshold: null,
		block_level: "soft",
		public_description: "Literal term",
		action: null,
		...overrides,
	};
}
function run(
	detectors: ModerationDetector[],
	rules: PolicyRule[],
	items = [text],
) {
	return runChecks({
		detectors,
		rules,
		items,
		controls: { version: "1", block_all: false, disabled_detectors: [] },
		timeout_ms: 1000,
	});
}
describe("literal rules", () => {
	it("uses only configured literal terms and never claims semantic safety", async () => {
		const adapter = createTextRulesDetector({
			version: "rules-1",
			literal_terms: [{ term: "banned phrase", category: "sexual" }],
		});
		const rules = [
			rule({
				layer: "rules",
				category: "sexual",
				minimum_scope: "text.rules",
				detector_ids: ["text-rules"],
				threshold: null,
			}),
		];
		expect(
			(await run([adapter], rules, [{ ...text, text: "BANNED PHRASE" }]))
				.decision,
		).toBe("block");
		expect((await run([adapter], rules)).decision).toBe("allow");
		expect(
			(await run([adapter], [{ ...rules[0]!, minimum_scope: "text.semantic" }]))
				.decision,
		).toBe("review");
		expect(() =>
			createTextRulesDetector({
				version: "1",
				literal_terms: [{ term: " ", category: "sexual" }],
			}),
		).toThrow();
	});
});
