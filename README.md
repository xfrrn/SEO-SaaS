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
| `packages/app-sdk` | 应用接入入口，统一导出认证、订阅及支付功能 |
| `packages/subscription` | 通用套餐、订阅记录和权益查询，包名为 `@app/subscription` |
| `packages/paypal` | 独立 PayPal 客户端及其测试，包名为 `@app/paypal` |
| `packages/better-auth` | 认证服务、客户端和内置插件 |
| `packages/core` | 公共类型和底层能力 |
| `packages/kysely-adapter` | SQL 适配器，支持本项目的 PostgreSQL `pg.Pool` 接入 |
| `packages/memory-adapter` | 内存适配器，供临时运行和测试使用 |
| 其他 `packages/*` | Stripe、SSO、Passkey 等独立功能包 |
| `test`、各包内的测试 | SDK 行为和类型回归测试 |
| `scripts` | 单包打包脚本及其测试 |

## 打包并接入其他项目

```bash
pnpm pack:sdk
```

产物为 **`dist/auth-sdk.tgz`**。其中包含本仓库构建的认证核心、Kysely/内存适配器、通用订阅、Stripe 及 PayPal 包，保留你的本地修改。复制到使用方项目的 `vendor/` 后安装：

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
| `@app/auth-sdk/subscription` | 通用订阅服务端插件 `subscription` |
| `@app/auth-sdk/subscription/client` | 通用订阅客户端插件 `subscriptionClient` |
| `@app/auth-sdk/stripe` | Stripe 服务端插件 |
| `@app/auth-sdk/stripe/client` | Stripe 客户端插件 |
| `@app/auth-sdk/paypal` | PayPal 订单、收款和 webhook 验签 |

React、Next.js、Stripe 是按需安装的依赖；纯服务端认证不需要它们。数据库驱动由使用方按数据库类型安装，例如 PostgreSQL：

```bash
pnpm add pg
pnpm add -D @types/pg
```

本项目使用 PostgreSQL 的直接连接方式，已移除 Prisma、Drizzle 和 MongoDB 适配器及对应导出。

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

## 通用套餐与订阅

`packages/subscription` 管理渠道无关的套餐定义、订阅记录和有效期查询。它不负责创建支付订单、自动扣款或用量计量；套餐的 `limits` 由业务代码执行。仅使用通用订阅时，不需要 Stripe 或 PayPal 配置。

将插件加入现有的 `betterAuth` 配置：

```ts
import { subscription } from "@app/auth-sdk/subscription";

const plans = [
  { name: "pro", limits: { projects: 10 }, group: "membership" },
];

// betterAuth({ ...其他认证配置, plugins: [subscription({ plans })] })
```

`plans` 也可以是返回套餐数组的异步函数；套餐通过配置提供，没有套餐增删改 HTTP 接口。浏览器客户端可将从 `@app/auth-sdk/subscription/client` 导入的 `subscriptionClient()` 加入客户端 `plugins`。

服务端查询需要当前请求的会话头：

```ts
const plans = await auth.api.listSubscriptionPlans({ headers: request.headers });
const subscriptions = await auth.api.listCustomerSubscriptions({
  headers: request.headers,
});
```

`listCustomerSubscriptions` 默认返回当前用户仍有效的订阅及套餐 `limits`，同时校验状态和起止日期。可通过 `query: { activeOnly: false }` 查询非有效状态的记录；查询组织等其他归属时传 `query: { referenceId }`，并在插件中提供 `authorizeReference` 校验访问权。

渠道回调或后台业务确认付款后，由受信服务端同步记录：

```ts
const result = await auth.api.syncSubscription({
  body: {
    provider: "paypal",
    providerSubscriptionId: membership.id,
    referenceId: membership.userId,
    plan: "pro",
    status: "active",
    periodStart: membership.periodStart,
    periodEnd: membership.periodEnd,
    revision: membership.revision,
  },
});
```

这里的 `membership` 是业务端已核验并持久化的会员授权记录，日期为明确的起止时间，`revision` 是针对同一授权持久化、单调递增的版本号。`providerSubscriptionId` 必须稳定标识同一份订阅；PayPal 一次性付款可使用业务端稳定的会员授权 ID，并不代表 PayPal 自动续费。重新收到相同付款通知时，应重用原版本和原有效期，不能以处理回调的时间重新增加天数。

`syncSubscription` 只有服务端调用入口，没有 HTTP 写入口。返回值为 `{ subscription, applied }`，相同或更旧的 `revision` 返回 `applied: false`，避免重放延长有效期或旧更新回滚记录。`applied` 仅表示本次订阅同步是否写入，不保证发货等其他业务操作只执行一次。调用前的支付验签、订单归属、付款状态、金额和币种核对，以及业务操作的去重仍由支付渠道接入和业务服务负责。

Stripe 继续负责其支付、订阅扣款及渠道回调。它复用通用订阅的类型、表结构和辅助函数，原有 Stripe API 保持兼容。两个插件同时启用时，可以共享同一份套餐定义；Stripe 的 `priceId` 仍需单独配置：

```ts
import Stripe from "stripe";
import { stripe } from "@app/auth-sdk/stripe";
import { subscription } from "@app/auth-sdk/subscription";

const plans = [
  { name: "pro", limits: { projects: 10 }, priceId: "price_your_pro_plan" },
];
const billingPlugins = [
  subscription({ plans }),
  stripe({
    stripeClient: new Stripe(process.env.STRIPE_SECRET_KEY!),
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
    subscription: { enabled: true, plans },
  }),
];
// 将 billingPlugins 放入 betterAuth 的 plugins 配置。
```

启用新插件前，需要按最终认证配置执行标准数据库迁移。通用订阅与 Stripe 可共用 `subscription` 表；若自定义表名或字段映射，两个插件必须使用相同配置，否则初始化会拒绝。Stripe 按渠道隔离处理记录，仍兼容未设置 `provider` 的旧 Stripe 数据。旧记录要参与通用权益查询，必须有有效的起止日期；建议先备份，再依据真实 Stripe 订阅核对并回填 `provider`、通用订阅 ID 及必要日期。

## PayPal.cn 接入

服务端实现位于独立包 [packages/paypal/src/index.ts](./packages/paypal/src/index.ts)，测试位于 [packages/paypal/test/paypal.test.ts](./packages/paypal/test/paypal.test.ts)。`app-sdk` 负责转发导出，业务项目的导入方式保持不变：

```ts
import { createPayPalClient } from "@app/auth-sdk/paypal";
```

使用 `clientId`、`clientSecret`、`webhookId` 初始化后，可调用 `createOrder`、`getOrder`、`captureOrder` 和 `verifyWebhook`。默认使用沙箱，正式环境配置 `environment: "live"`。该接口提供 PayPal Orders v2 一次性付款能力；订单持久化、用户授权和付款后的业务处理由使用方负责，不含自动续费。

## 测试

```bash
# SDK 入口、认证流程、Stripe、通用订阅和独立 PayPal 包测试
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
