import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./billing/app/api/premium/route";
import { requiredEnv } from "./lib/env";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	listActiveSubscriptions: vi.fn(),
}));

vi.mock("./billing/lib/auth", () => ({ auth: { api: mocks } }));

beforeEach(() => {
	vi.resetAllMocks();
	vi.unstubAllEnvs();
});

describe("Next.js example configuration and paid route", () => {
	it("requires non-empty server configuration", () => {
		vi.stubEnv("APP_SDK_TEST_REQUIRED", "");
		expect(() => requiredEnv("APP_SDK_TEST_REQUIRED")).toThrow(
			"APP_SDK_TEST_REQUIRED",
		);
		vi.stubEnv("APP_SDK_TEST_REQUIRED", "   ");
		expect(() => requiredEnv("APP_SDK_TEST_REQUIRED")).toThrow(
			"APP_SDK_TEST_REQUIRED",
		);
		vi.stubEnv("APP_SDK_TEST_REQUIRED", "configured");
		expect(requiredEnv("APP_SDK_TEST_REQUIRED")).toBe("configured");
	});

	it("rejects anonymous requests before querying subscriptions", async () => {
		mocks.getSession.mockResolvedValue(null);
		const response = await GET(new Request("https://example.com/api/premium"));
		expect(response.status).toBe(401);
		expect(mocks.listActiveSubscriptions).not.toHaveBeenCalled();
	});

	it.each([
		["other-user", "pro", "active", 403],
		["user-1", "free", "active", 403],
		["user-1", "pro", "canceled", 403],
		["user-1", "pro", "past_due", 403],
		["user-1", "basic", "active", 200],
		["user-1", "pro", "trialing", 200],
	])("checks owner %s, plan %s, status %s -> %s", async (referenceId, plan, status, expectedStatus) => {
		mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
		mocks.listActiveSubscriptions.mockResolvedValue([{ referenceId, plan, status }]);
		const request = new Request("https://example.com/api/premium", {
			headers: { cookie: "better-auth.session_token=test-session" },
		});
		expect((await GET(request)).status).toBe(expectedStatus);
		expect(mocks.getSession).toHaveBeenCalledWith({ headers: request.headers });
		expect(mocks.listActiveSubscriptions).toHaveBeenCalledWith({
			headers: request.headers,
		});
	});

	it("rejects a valid session without a subscription", async () => {
		mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
		mocks.listActiveSubscriptions.mockResolvedValue([]);
		const response = await GET(new Request("https://example.com/api/premium"));
		expect(response.status).toBe(403);
	});

	it("does not grant access when subscription lookup fails", async () => {
		mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
		mocks.listActiveSubscriptions.mockRejectedValue(
			new Error("database unavailable"),
		);
		await expect(
			GET(new Request("https://example.com/api/premium")),
		).rejects.toThrow("database unavailable");
	});
});
