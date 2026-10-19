const day = 86_400_000;

export type MetricsQuery =
	| { view: "snapshot" }
	| {
			view: "registrations" | "users";
			from: Date;
			to: Date;
			page: number;
			q: string;
	  };

/** Parse the bounded UTC reporting contract before touching the database. */
export function parseMetricsQuery(url: URL, now: number): MetricsQuery {
	const params = url.searchParams;
	if (!params.size) return { view: "snapshot" };
	const view = params.get("view");
	if (view !== "registrations" && view !== "users") {
		throw new Error("Invalid view");
	}
	const allowed = new Set(
		view === "users"
			? ["view", "from", "to", "page", "q"]
			: ["view", "from", "to"],
	);
	for (const key of params.keys()) {
		if (!allowed.has(key) || params.getAll(key).length !== 1) {
			throw new Error("Unknown or repeated parameter");
		}
	}
	const date = (key: string) => {
		const value = params.get(key) ?? "";
		if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Invalid date");
		const parsed = new Date(`${value}T00:00:00.000Z`);
		if (
			!Number.isFinite(parsed.getTime()) ||
			parsed.toISOString().slice(0, 10) !== value
		) {
			throw new Error("Invalid date");
		}
		return parsed;
	};
	const from = date("from");
	const to = date("to");
	const today = Math.floor(now / day) * day;
	if (
		from.getTime() > today ||
		to.getTime() > today + day ||
		to <= from ||
		to.getTime() - from.getTime() > 366 * day
	) {
		throw new Error("Invalid period");
	}
	const page = params.get("page") ?? "1";
	const q = (params.get("q") ?? "").trim();
	if (!/^[1-9]\d{0,5}$/.test(page) || q.length > 200) {
		throw new Error("Invalid pagination or search");
	}
	return { view, from, to, page: Number(page), q };
}
