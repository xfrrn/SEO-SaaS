import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
	title: "管理后台",
	description: "用户、套餐、订单与权益管理",
	robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="zh-CN" suppressHydrationWarning>
			<body className="font-sans antialiased">
				<ThemeProvider attribute="class" defaultTheme="light" enableSystem>
					{children}
				</ThemeProvider>
			</body>
		</html>
	);
}
