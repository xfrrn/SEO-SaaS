import assert from "node:assert/strict";
import test from "node:test";
import { getPendingOperation } from "../lib/operation.ts";

function sessionStorage() {
	const entries = new Map<string, string>();
	return {
		getItem: (key: string) => entries.get(key) ?? null,
		setItem: (key: string, value: string) => {
			entries.set(key, value);
		},
		removeItem: (key: string) => {
			entries.delete(key);
		},
	};
}

const payload = {
	referenceId: "customer",
	action: "grant",
	amount: 100,
	reason: "Restore a lost response",
};

test("reopening or refreshing reuses the pending operation until confirmed", () => {
	const storage = sessionStorage();
	const first = getPendingOperation("admin", payload, () => storage);
	const reopened = getPendingOperation("admin", { ...payload }, () => storage);
	assert.equal(first.id, reopened.id);
	reopened.complete();
	const next = getPendingOperation("admin", payload, () => storage);
	assert.notEqual(next.id, first.id);
	// A late response from the first request must not erase the next operation.
	first.complete();
	assert.equal(
		getPendingOperation("admin", payload, () => storage).id,
		next.id,
	);
});

test("different actors and payloads retain separate pending operation IDs", () => {
	const storage = sessionStorage();
	const first = getPendingOperation("admin", payload, () => storage);
	const changed = getPendingOperation(
		"admin",
		{ ...payload, amount: 200 },
		() => storage,
	);
	const other = getPendingOperation("other-admin", payload, () => storage);
	assert.equal(new Set([first.id, changed.id, other.id]).size, 3);
	assert.equal(
		getPendingOperation("admin", payload, () => storage).id,
		first.id,
	);
	assert.equal(
		getPendingOperation(
			"admin",
			Object.fromEntries(Object.entries(payload).reverse()),
			() => storage,
		).id,
		first.id,
	);
	assert.throws(() => getPendingOperation("", payload, () => storage), /会话/);
});

test("unavailable or failed storage prevents an operation from being submitted", () => {
	const unavailable = () => {
		throw new Error("Storage is unavailable");
	};
	for (const storage of [
		unavailable,
		() => ({ ...sessionStorage(), getItem: unavailable }),
		() => ({ ...sessionStorage(), setItem: unavailable }),
		() => ({ ...sessionStorage(), setItem: () => {} }),
	]) {
		assert.throws(
			() => getPendingOperation("admin", payload, storage),
			/无法保存操作记录/,
		);
	}
	const storage = { ...sessionStorage(), removeItem: unavailable };
	const pending = getPendingOperation("admin", payload, () => storage);
	assert.throws(() => pending.complete(), /操作已成功/);
	assert.equal(
		getPendingOperation("admin", payload, () => storage).id,
		pending.id,
	);
});
