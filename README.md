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
| `packages/app-sdk` | 应用接入入口，统一导出认证、订阅、credits 及支付功能 |
| `packages/subscription` | 通用套餐、订阅记录和权益查询，包名为 `@app/subscription` |
| `packages/credits` | 独立积分余额、发放、扣减和流水插件，包名为 `@app/credits` |
| `packages/business` | 组合业务插件：商品管理、订单、付款履约、人工调整、退款后处理及后台查询 |
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

产物为 **`dist/auth-sdk.tgz`**。其中包含本仓库构建的认证核心、Kysely/内存适配器、通用订阅、credits、business、Stripe 及 PayPal 包，保留你的本地修改。复制到使用方项目的 `vendor/` 后安装：

```bash
pnpm add ./vendor/auth-sdk.tgz
```

不需要额外安装公共 registry 上的 `better-auth`。普通第三方运行依赖仍由 pnpm 安装，因此这是一个安装包，不是离线依赖全集。请使用根目录的 `pack:sdk`，直接对 `packages/app-sdk` 执行 `pack` 只会得到入口层。

SSO、Passkey、SCIM 等独立包的源码和测试仍保留，主 SDK 的打包范围为下表入口及其依赖；独立包可按需单独构建和接入。

| 导入路径 | 功能 |
| --- | --- |
| `@app/auth-sdk/server` | `betterAuth`、认证配置及服务端类型 |
| `@app/auth-sdk/metrics` | 环境变量控制的站点只读统计接口 `createMetricsHandler` |
| `@app/auth-sdk/plugins` | 内置服务端插件 |
| `@app/auth-sdk/client/plugins` | 内置客户端插件 |
| `@app/auth-sdk/react` | `createAuthClient`、React 会话能力 |
| `@app/auth-sdk/next-js` | `toNextJsHandler`、`nextCookies` |
| `@app/auth-sdk/subscription` | 通用订阅服务端插件 `subscription` |
| `@app/auth-sdk/subscription/client` | 通用订阅客户端插件 `subscriptionClient` |
| `@app/auth-sdk/credits` | credits 服务端插件 `credits` |
| `@app/auth-sdk/credits/client` | credits 客户端插件 `creditsClient` |
| `@app/auth-sdk/business` | 组合业务插件 `business`，管理接口及可信付款回调入口 |
| `@app/auth-sdk/business/client` | 组合业务客户端插件 `businessClient` |
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

## SEO-worker 站点统计

`@app/auth-sdk/metrics` 提供可选的 `createMetricsHandler`，第一期仅返回当前用户数、最近 7 × 24 小时新增用户数、UTC 本月至今的付费用户数。每个网站使用独立数据库、站点 ID 和服务凭证；`siteId` 只标识返回数据，不会按站点过滤共享用户库。

在接入网站的服务端环境变量中开启，凭证由网站与 SEO-worker 的服务端保存：

```dotenv
APP_METRICS_ENABLED=true
APP_METRICS_SITE_ID=my_site
APP_METRICS_TOKEN=<替换为独立随机生成的服务凭证>
APP_METRICS_RATE_LIMIT_PER_MINUTE=6
```

只有 `APP_METRICS_ENABLED` 精确为 `true` 才启用；其他值返回 404。凭证必须是 32～256 个 URL 安全字符，须使用密码学安全随机数生成，不能复用认证密钥或放入前端环境变量。启用后缺少凭证、站点 ID 或付款查询回调会在初始化时抛错。

例如在使用方 Next.js 的 `app/internal/metrics/route.ts` 中挂载：

```ts
import { createMetricsHandler } from "@app/auth-sdk/metrics";
import { auth } from "@/lib/auth";
import { countPaidUsers } from "@/lib/payment-metrics"; // 应用自己的已核验付款查询

// 每个网站、每个运行实例只创建一次，不能放到请求处理函数中重建。
export const GET = createMetricsHandler({
  env: process.env,
  auth,
  countPaidUsers,
});
```

SEO-worker 使用 `Authorization: Bearer <凭证>` 请求已登记的 HTTPS 接口地址，不带查询参数。SDK 统计认证用户表；应用的 `countPaidUsers` 必须查询已核验、成功且金额大于零的付款记录，并按用户去重，不能使用有效订阅数代替付费人数。

接口默认每实例每分钟最多接收 60 次鉴权尝试、6 次已授权请求，包含缓存读取；返回 429 时携带 `Retry-After`。统计快照缓存 60 秒，每实例最多执行一批统计查询，响应超时为 5 秒；查询失败返回 503 并退避 60 秒，不用 0 掩盖故障。多实例或无服务器部署需配置共享原子限流存储或网关限流，数据库还须设置查询超时及连接池上限；响应超时不能保证底层数据库查询取消。

完整指标口径、环境变量、共享限流及 SEO-worker 接入约定见 [SDK 站点统计说明](./packages/app-sdk/README.md#seo-worker-站点统计)。

## 组合业务与后台接口

基础能力继续由现有插件提供，只有 `business` 是新插件。接入应用启用：

```ts
import { admin } from "@app/auth-sdk/plugins";
import { subscription } from "@app/auth-sdk/subscription";
import { credits } from "@app/auth-sdk/credits";
import { business } from "@app/auth-sdk/business";
import { paymentProviders } from "./payment-providers";

// 加到 betterAuth 的 plugins 数组；数据库迁移须包含全部启用插件。
const plugins = [
  admin({ auditLog: true }),
  subscription({ catalog: true }),
  credits(),
  business({ providers: paymentProviders }),
];
```

`paymentProviders` 将网站现有支付集成适配到 `BusinessPaymentProvider`：创建结账、服务端核验已完成付款、可选的已完成退款核验。插件不提供新的自动扣款或发起退款接口。客户端启用 `businessClient()` 后调用 `/business/*`；管理员接口重新读取可信会话，默认只允许 Admin 配置的管理员，可用 `authorize` 逐操作授权。

组合写入要求真实事务和唯一约束。本仓库直接连接的 PostgreSQL、SQLite 可用；内存适配器和没有交互事务的 D1 不支持该组合插件。数据库由网站提供，插件不独立启动服务。会员、积分、订单状态和成功审计在同一事务提交；可信付款记录先保存，发货失败保留已付款状态，管理端可安全重试。

支持购买发货、实际续费付款后的赠送、积分批次到期、人工调整、退款后的权益处理。全额退款回收对应批次剩余额度；部分退款和已消费额度标记人工处理，不自动倒扣其他积分。概览的付费人数只统计经过此业务插件确认的订单，包含随后退款的付款，不自动汇总外部历史订单。

完整接口、支付适配要求和迁移约定见 [SDK 组合业务说明](./packages/app-sdk/README.md#组合业务与后台接口)。当前仍不包含 Dashboard 页面，待接入指定模板。

## 通用套餐与订阅

商品目录可通过 `subscription({ catalog: true })` 开启，支持纯积分、纯会员和会员加积分。商品以不可变版本保存；修改、上下架均创建新版本，旧订单和会员继续引用购买时的版本。通过 `createProductService(adapter)` 或业务插件的管理接口编辑，现有 `subscription({ plans })` 配置方式保持兼容。

`packages/subscription` 管理渠道无关的套餐定义、订阅记录和有效期查询。它不负责创建支付订单、自动扣款或用量计量；套餐的 `limits` 由业务代码执行。仅使用通用订阅时，不需要 Stripe 或 PayPal 配置。

将插件加入现有的 `betterAuth` 配置：

```ts
import { subscription } from "@app/auth-sdk/subscription";

const plans = [
  { name: "pro", limits: { projects: 10 }, group: "membership" },
];

// betterAuth({ ...其他认证配置, plugins: [subscription({ plans })] })
```

`plans` 也可以是返回套餐数组的异步函数；未启用 `catalog` 时，套餐仍通过配置提供。底层商品写入只供可信服务端调用；面板使用业务插件鉴权后的编辑接口。浏览器客户端可将从 `@app/auth-sdk/subscription/client` 导入的 `subscriptionClient()` 加入客户端 `plugins`。

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

## Credits 额度

`packages/credits` 独立管理整数额度，可用于按次调用、任务消耗或套餐赠送，不依赖订阅或支付渠道。服务端启用插件，并按最终认证配置迁移数据库：

```ts
import { credits } from "@app/auth-sdk/credits";

// betterAuth({ ...其他认证配置, plugins: [credits()] })
```

余额初始为 0。发放与扣减仅供受信服务端调用，没有 HTTP 写入口；业务端负责验证调用者、订单和使用权限。`amount` 必须是正的安全整数；扣减超过余额会失败。

```ts
// 在服务端确认付款并核对订单归属、金额和币种后发放。
await auth.api.grantCredits({
  body: {
    referenceId: user.id,
    amount: 1000,
    idempotencyKey: `stripe:invoice:${paidInvoice.id}:credits`,
    reason: "每月套餐额度",
  },
});

await auth.api.consumeCredits({
  body: {
    referenceId: user.id,
    amount: 10,
    idempotencyKey: `job:${job.id}:consume`,
    reason: "生成任务",
  },
});

const { balance } = await auth.api.getCreditsBalance({
  headers: request.headers,
});
const { entries, nextCursor } = await auth.api.listCreditsLedger({
  headers: request.headers,
  query: { limit: 20 }, // 下一页传 cursor: nextCursor
});
```

写入返回 `{ entry, applied }`。同一账户的同一个 `idempotencyKey` 只能记录一次；重试必须保持操作、数量和原因一致，否则报冲突。超时或结果不确定时应使用原 key 重试。`applied: false` 返回原流水，里面的余额是该笔操作完成时的余额；当前余额请重新查询。

查询默认只允许当前用户；查询组织等其他账户时传 `query: { referenceId }`，并配置 `credits({ authorizeReference })` 校验权限。浏览器可在客户端配置中加入从 `@app/auth-sdk/credits/client` 导入的 `creditsClient()`，再调用 `client.credits.balance()` 或 `client.credits.ledger({ query: { limit: 20 } })`。

额度默认永久有效并累积；发放时可传 `source` 和绝对日期 `expiresAt`。消费先使用最早到期批次；读取余额、流水或写入时追加过期记录，过期积分不可消费。`revokeCreditsGrant` 按原发放 key 回收该批次剩余有效积分，不会扣其他批次；已消费或已过期部分返回 `unavailable`。历史无期限积分仍永久有效。套餐中的 `limits.monthlyCredits` 不会自动发放；本次不提供定时发放、年费按月赠送或新的支付渠道操作。

流水只追加，余额随流水保存；SQL 唯一约束负责串行化同一账户的并发写入并避免重复记账。插件要求数据库迁移包含这些约束，支持本项目的 PostgreSQL/Kysely 接入，不支持内存适配器。不要直接修改或删除流水。额度操作不与外部业务任务共同提交；任务失败需要返还时，用新的稳定 key 调用 `grantCredits` 记录补偿。

## PayPal.cn 接入

服务端实现位于独立包 [packages/paypal/src/index.ts](./packages/paypal/src/index.ts)，测试位于 [packages/paypal/test/paypal.test.ts](./packages/paypal/test/paypal.test.ts)。`app-sdk` 负责转发导出，业务项目的导入方式保持不变：

```ts
import { createPayPalClient } from "@app/auth-sdk/paypal";
```

使用 `clientId`、`clientSecret`、`webhookId` 初始化后，可调用 `createOrder`、`getOrder`、`captureOrder` 和 `verifyWebhook`。默认使用沙箱，正式环境配置 `environment: "live"`。该接口提供 PayPal Orders v2 一次性付款能力；订单持久化、用户授权和付款后的业务处理由使用方负责，不含自动续费。

可选的 `orderExpiration: true` 将**业务订单创建后的付款期限**设为 30 分钟；`orderExpiration: { ttlMs: 15 * 60_000 }` 可自定义正整数毫秒数。省略或设为 `false` 时，旧调用保持不变。它与套餐、积分有效期以及 HTTP 请求超时无关：

```ts
const paypal = createPayPalClient({
  clientId: process.env.PAYPAL_CLIENT_ID!,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
  webhookId: process.env.PAYPAL_WEBHOOK_ID!,
  orderExpiration: true,
});

// 仅在首次创建业务订单时执行，时间来自服务端。
const createdAt = Date.now();
const expiresAt = paypal.calculateOrderExpiresAt(createdAt);
// 应用先持久化 createdAt、expiresAt 和稳定的创建/扣款 requestId，再调用 PayPal。
// 重试、刷新和恢复订单都读取原记录，不重新计算 expiresAt。
paypal.assertOrderPayable(expiresAt);
// createOrder({ ...原参数, expiresAt }) / captureOrder({ ...原参数, expiresAt })
// 也会在发起付款请求前检查应用从数据库读取的 expiresAt。
```

启用后缺少 `expiresAt` 会拒绝付款；即使之后关闭配置，显式传入的已保存期限仍会校验。到达期限时抛出可由 `isPayPalOrderExpiredError` 识别的 `PAYPAL_ORDER_EXPIRED` 错误，仅表示本次付款请求被阻止，不证明先前没有扣款，也不会关闭 PayPal 平台订单。查询与验签始终保留；已扣款、结果不确定及延迟回调必须继续对账并幂等履约或退款。前端倒计时只作展示。

SDK 不增加订单数据库、定时任务或退款 API。完整的保存期限、恢复订单、处理过期错误与延迟回调示例，以及 IAMF 接入清单，见 [SDK 的未付款订单有效期说明](./packages/app-sdk/README.md#未付款订单有效期)。

## 测试

```bash
# SDK 入口、认证流程、Stripe、通用订阅、credits 和独立 PayPal 包测试
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
