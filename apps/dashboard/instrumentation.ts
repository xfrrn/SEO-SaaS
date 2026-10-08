/** Start background delivery independently of dashboard page visits. */
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { startDashboardMonitor } = await import("./lib/auth");
		startDashboardMonitor();
	}
}
