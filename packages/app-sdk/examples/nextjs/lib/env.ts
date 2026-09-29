/** 读取服务端必填配置，缺少配置时立即报错。 */
export function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value?.trim()) {
		throw new Error(`缺少环境变量 ${name}，请检查 .env`);
	}
	return value;
}
