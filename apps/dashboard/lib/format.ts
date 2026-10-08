export function formatDate(value: Date | string | null | undefined) {
	if (!value) return "—";
	return new Intl.DateTimeFormat("zh-CN", {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}

export function currencyDigits(currency: string) {
	return (
		new Intl.NumberFormat("zh-CN", {
			style: "currency",
			currency,
		}).resolvedOptions().maximumFractionDigits ?? 2
	);
}

export function money(amount: number, currency: string) {
	const [integer, fraction] = priceInput(amount, currency).split(".");
	return new Intl.NumberFormat("zh-CN", { style: "currency", currency })
		.formatToParts(BigInt(integer!))
		.map((part) => (part.type === "fraction" ? fraction : part.value))
		.join("");
}

export function priceInput(amount: number, currency: string) {
	const digits = currencyDigits(currency);
	const units = String(amount).padStart(digits + 1, "0");
	return digits ? `${units.slice(0, -digits)}.${units.slice(-digits)}` : units;
}

export function parsePrice(value: string, currency: string) {
	const digits = currencyDigits(currency);
	if (
		!new RegExp(`^\\d+(?:\\.\\d{1,${Math.max(1, digits)}})?$`).test(
			value.trim(),
		) ||
		(!digits && value.includes("."))
	)
		throw new Error("请输入正确的价格和小数位数。");
	const [integer, fraction = ""] = value.trim().split(".");
	const result = Number(integer + fraction.padEnd(digits, "0"));
	if (!Number.isSafeInteger(result)) throw new Error("价格超出可用范围。");
	return result;
}

export const orderStatus = {
	pending: "待付款",
	paid: "待履约",
	fulfilled: "已履约",
	partially_refunded: "部分退款",
	refunded: "已退款",
} as const;

export function localDateInput(value: Date | string) {
	const date = new Date(value);
	return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
		.toISOString()
		.slice(0, 16);
}
