type OperationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Persist an unconfirmed write across dialog lifetimes and reloads in this tab. */
export function getPendingOperation(
	actorId: string,
	payload: unknown,
	getStorage: () => OperationStorage = () => window.sessionStorage,
) {
	if (!actorId) throw new Error("管理员会话不可用，请重新登录后重试。");
	const key = `dashboard:pending-operation:${JSON.stringify(
		[actorId, payload],
		(_key, value: unknown) =>
			value && typeof value === "object" && !Array.isArray(value)
				? Object.fromEntries(
						Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
					)
				: value,
	)}`;
	let storage: OperationStorage;
	let id: string;
	try {
		storage = getStorage();
		id = storage.getItem(key) ?? crypto.randomUUID();
		storage.setItem(key, id);
		if (storage.getItem(key) !== id) throw new Error("Operation was not saved");
	} catch {
		throw new Error("无法保存操作记录，请启用浏览器会话存储后重试。");
	}
	return {
		id,
		complete() {
			try {
				if (storage.getItem(key) === id) storage.removeItem(key);
			} catch {
				throw new Error(
					"操作已成功，但无法清除重试记录；请恢复浏览器会话存储后重试确认。",
				);
			}
		},
	};
}
