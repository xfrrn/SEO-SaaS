# Auth SDK

基于 Better Auth 的可修改、可测试 SDK。对外使用 `@app/auth-sdk`，保留原生认证、插件、数据库适配器和支付实现。此仓库只提供 SDK 源码和开发工具，不包含前端网站或管理后台。

## 开发

使用 Node.js 24（见 `.nvmrc`）和 pnpm 11。在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build:sdk
pnpm test:sdk
pnpm typecheck
```

修改 `packages/` 中的源码后重新构建。`pnpm dev` 监听主 SDK 及其依赖的源码变化；`pnpm build` 构建所有保留的 SDK 包，包括独立插件。

| 路径 | 用途 |
| --- | --- |
| `packages/app-sdk` | 应用接入入口及 PayPal 客户端 |
| `packages/better-auth` | 认证服务、客户端和内置插件 |
| `packages/core` | 公共类型和底层能力 |
| `packages/*-adapter` | 数据库适配器 |
| 其他 `packages/*` | Stripe、SSO、Passkey 等独立功能包 |
| `test`、各包内的测试 | SDK 行为和类型回归测试 |
| `scripts` | 单包打包脚本及其测试 |

## 打包并接入其他项目

```bash
pnpm pack:sdk
```

产物为 **`dist/auth-sdk.tgz`**。其中包含本仓库构建的认证核心、适配器及 Stripe 包，保留你的本地修改。复制到使用方项目的 `vendor/` 后安装：

```bash
pnpm add ./vendor/auth-sdk.tgz
```

不需要额外安装公共 registry 上的 `better-auth`。普通第三方运行依赖仍由 pnpm 安装，因此这是一个安装包，不是离线依赖全集。请使用根目录的 `pack:sdk`，直接对 `packages/app-sdk` 执行 `pack` 只会得到入口层。

SSO、Passkey、SCIM 等独立包的源码和测试仍保留，主 SDK 的打包范围为下表入口及其依赖；独立包可按需单独构建和接入。

| 导入路径 | 功能 |
| --- | --- |
| `@app/auth-sdk/server` | `betterAuth`、认证配置及服务端类型 |
| `@app/auth-sdk/plugins` | 内置服务端插件 |
| `@app/auth-sdk/client/plugins` | 内置客户端插件 |
| `@app/auth-sdk/react` | `createAuthClient`、React 会话能力 |
| `@app/auth-sdk/next-js` | `toNextJsHandler`、`nextCookies` |
| `@app/auth-sdk/stripe` | Stripe 服务端插件 |
| `@app/auth-sdk/stripe/client` | Stripe 客户端插件 |
| `@app/auth-sdk/paypal` | PayPal 订单、收款和 webhook 验签 |

React、Next.js、Stripe 是按需安装的依赖；纯服务端认证不需要它们。数据库驱动由使用方按数据库类型安装，例如 PostgreSQL：

```bash
pnpm add pg
pnpm add -D @types/pg
```

```ts
import { betterAuth } from "@app/auth-sdk/server";
import { Pool } from "pg";

export const auth = betterAuth({
  database: new Pool({ connectionString: process.env.DATABASE_URL }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  emailAndPassword: { enabled: true },
});

// 在应用的服务端路由中将认证请求交给 auth.handler(request)。
// 会话检查必须传入当前请求的 headers。
export async function getSession(request: Request) {
  return auth.api.getSession({ headers: request.headers });
}
```

在需要创建账号的服务端业务函数中调用：

```ts
const result = await auth.api.signUpEmail({
  body: { name: "张三", email: "user@example.com", password: "a-strong-password" },
});
```

浏览器登录、注册时，将 `/api/auth/*` 请求交给 `auth.handler(request)` 并返回其完整响应，以保留会话 Cookie。Next.js App Router 可在使用方的 `app/api/auth/[...all]/route.ts` 中导出：

```ts
import { toNextJsHandler } from "@app/auth-sdk/next-js";
import { auth } from "@/lib/auth"; // 上面的服务端配置

export const { GET, POST } = toNextJsHandler(auth);
```

数据库表需按认证配置和启用的插件预先迁移。SDK 不会自动建表，也不会独立启动 HTTP 服务；由使用方应用挂载认证路由、配置环境变量和管理数据库迁移。

## 测试

```bash
# SDK 入口、认证流程、Stripe 和 PayPal 测试
pnpm test:sdk

# 打包依赖、导出条件和缺失构建产物检查
pnpm test:packaging

# 修改某个原生插件时，只运行相关测试
pnpm exec vitest run packages/better-auth/src/plugins/username

# 所有保留包和 SDK 测试的类型检查
pnpm typecheck
```

默认 SDK 测试不需要 Docker。外部数据库测试配置位于 `test/docker-compose.yml`，例如启动 PostgreSQL：`docker compose --project-directory . -f test/docker-compose.yml up -d postgres`。

认证代码继续遵守 [MIT License](./LICENSE.md)。开发约定见 [AGENTS.md](./AGENTS.md)。
