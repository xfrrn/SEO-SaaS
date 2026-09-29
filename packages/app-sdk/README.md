# 认证与支付 SDK

`@app/auth-sdk` 将 Better Auth 原生 API 按服务端、React、Next.js、插件和 Stripe 分开导出。登录方法、返回值、错误和 TypeScript 推导保持原样；Stripe 按需启用。

先读 [中文快速接入手册（仓库源码）](../../docs/content/docs/guides/sdk-quickstart-zh.mdx)，再按 [插件分类手册（仓库源码）](../../docs/content/docs/guides/sdk-plugins-zh.mdx) 选择功能。这两个相对链接用于源码仓库；文档站对应 `/docs/guides/sdk-quickstart-zh` 和 `/docs/guides/sdk-plugins-zh`。

## 本地打包与安装

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@app/auth-sdk
pnpm --filter @app/auth-sdk pack --out packages/app-sdk/auth-sdk.tgz
```

产物为 `packages/app-sdk/auth-sdk.tgz`。将它复制到现有应用的 `vendor/`，然后在应用根目录安装：

```bash
pnpm add ./vendor/auth-sdk.tgz better-auth@1.7.6 pg
pnpm add -D @types/pg
```

这是私有的本地安装包，没有发布到公共 registry。React、Next.js 使用应用已有依赖。启用支付时再安装 `pnpm add @better-auth/stripe@1.7.6 stripe@^22`；升级时保持原生包版本匹配。

## 入口

| 入口 | 内容 |
| --- | --- |
| `@app/auth-sdk/server` | `betterAuth` 和原生服务端类型 |
| `@app/auth-sdk/react` | `createAuthClient`，实例提供 `useSession` 等 React 能力 |
| `@app/auth-sdk/next-js` | `toNextJsHandler`、`nextCookies` |
| `@app/auth-sdk/plugins` | 内置服务端插件 |
| `@app/auth-sdk/client/plugins` | 内置客户端插件 |
| `@app/auth-sdk/stripe` | 可选 Stripe 服务端插件 |
| `@app/auth-sdk/stripe/client` | 可选 `stripeClient` |

```ts
import { createAuthClient } from "@app/auth-sdk/react";

export const authClient = createAuthClient();
// authClient.signIn.email({ email, password })
// authClient.signUp.email({ name, email, password })
// authClient.signOut()
// authClient.getSession()
// authClient.useSession() 仅在 React 组件／Hook 中调用
```

服务端与客户端分开配置；不要在客户端导入 `auth`、数据库或密钥。服务端会话检查始终传当前请求的 `headers`。独立插件和适配器继续支持原生包路径，见分类手册。

## 复制 Next.js 示例

[examples/nextjs](./examples/nextjs) 是可合并进现有 App Router 项目的文件集：

1. 复制 `lib/` 和 `app/api/auth/[...all]/route.ts`，合并示例首页所需 UI；已有 `app/layout.tsx` 保留并合并所需内容。使用 `src/` 布局时放到 `src/lib/`、`src/app/`。
2. 将 `.env.example` 复制为应用根目录 `.env`，填写 `BETTER_AUTH_SECRET`、`BETTER_AUTH_URL`、`DATABASE_URL`。
3. 运行 `npx auth@latest migrate --config ./lib/auth.ts` 建表；`src/` 布局改用 `./src/lib/auth.ts`。Prisma／Drizzle 使用 `generate` 后走现有 ORM 迁移流程。
4. 使用现有项目的开发命令，验证注册、登录、退出和会话。
5. 需要支付时，将 `billing/` 内的文件按其相对位置合并进项目，补齐 Stripe 环境变量，再次迁移并配置 `/api/auth/stripe/webhook`。`billing/app/billing/page.tsx` 提供订阅操作，`billing/app/api/premium/route.ts` 示范服务端权益检查。

完整的配置来源、月付／年付、套餐切换、取消／恢复、账单门户和旧 SDK 调用对照都在中文快速接入手册中。示例采用 Node.js + `pg.Pool`；支付授权读取服务端订阅状态。生产用户、密码与旧登录态不会自动迁移。
