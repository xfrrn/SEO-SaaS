"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BackgroundRippleEffect } from "./background-ripple-effect";
import Header from "./header";

export default function SiteShell({ children }: { children: ReactNode }) {
	const pathname = usePathname();

	if (pathname === "/admin" || pathname.startsWith("/admin/")) {
		return <>{children}</>;
	}

	return (
		<div className="min-h-[calc(100vh-3.5rem)] mt-14 w-full relative">
			<Header />
			<div className="absolute inset-0 z-0">
				<BackgroundRippleEffect />
			</div>
			<div className="relative z-10 max-w-4xl w-full p-6 mx-auto">
				{children}
			</div>
		</div>
	);
}
