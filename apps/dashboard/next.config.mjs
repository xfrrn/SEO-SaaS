/** @type {import('next').NextConfig} */
const nextConfig = {
	serverExternalPackages: ["better-sqlite3", "pg"],
	poweredByHeader: false,
};
export default nextConfig;
