import "./globals.css";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import Providers from "@/components/providers";
import SiteShell from "@/components/site-shell";
import { createMetadata } from "@/lib/metadata";

export const metadata: Metadata = createMetadata({
	title: {
		template: "%s | Better Auth",
		default: "Better Auth",
	},
	description: "The most comprehensive authentication framework for TypeScript",
	metadataBase: new URL("https://demo.better-auth.com"),
});

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<link rel="icon" href="/favicon/favicon.ico" sizes="any" />
			</head>
			<body className={`${GeistSans.variable} ${GeistMono.variable} font-sans`}>
				<Providers>
					<SiteShell>{children}</SiteShell>
				</Providers>
			</body>
		</html>
	);
}
