import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="zh-CN">
			<body>
				<main style={{ maxWidth: 640, margin: "48px auto", padding: 24 }}>
					{children}
				</main>
			</body>
		</html>
	);
}
