"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { getPendingOperation } from "@/lib/operation";

/** Unwrap the existing SDK response without inventing a second HTTP API. */
export async function api<T>(
	request: Promise<{
		data: T | null;
		error: { message?: string; status?: number; code?: string } | null;
	}>,
): Promise<T> {
	const result = await request;
	if (result.error)
		throw Object.assign(
			new Error(result.error.message || "操作未完成，请重试。"),
			result.error,
		);
	return result.data as T;
}

export function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : "请求未完成，请稍后重试。";
}

/** Ignore stale responses when a filter or selected user changes. */
export function useResource<T>(key: string, load: () => Promise<T>) {
	const loader = useRef(load);
	loader.current = load;
	const [version, setVersion] = useState(0);
	const [state, setState] = useState<{
		data?: T;
		error: string;
		loading: boolean;
	}>({ error: "", loading: true });
	useEffect(() => {
		let current = true;
		setState({ error: "", loading: true });
		void loader.current().then(
			(data) => {
				if (current) setState({ data, error: "", loading: false });
			},
			(error: unknown) => {
				if (current) setState({ error: errorMessage(error), loading: false });
			},
		);
		return () => {
			current = false;
		};
	}, [key, version]);
	const reload = useCallback(() => setVersion((value) => value + 1), []);
	return { ...state, reload };
}

/** Clear a persisted operation only after the server confirms success. */
export function useOperation() {
	const session = authClient.useSession();
	const pending = useRef<ReturnType<typeof getPendingOperation> | null>(null);
	return {
		key(payload: unknown) {
			pending.current = getPendingOperation(
				session.data?.user.id ?? "",
				payload,
			);
			return pending.current.id;
		},
		reset() {
			pending.current?.complete();
			pending.current = null;
		},
	};
}
