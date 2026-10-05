# 认证与支付 SDK

`@app/auth-sdk` 统一导出 Better Auth 服务端、客户端插件、React、Next.js、通用订阅、credits、Stripe 和 PayPal 功能，保持各功能包的参数、返回值和类型推导。

## 安装

将仓库根目录执行 `pnpm pack:sdk` 生成的 `dist/auth-sdk.tgz` 复制到使用方项目：

```bash
pnpm add ./vendor/auth-sdk.tgz
```

此安装包内含本地构建的 Better Auth 核心及其工作区运行依赖，无需另外安装公共版本 `better-auth`。第三方运行依赖由包管理器安装；数据库驱动由使用方选择。React、Next.js、Stripe 只在使用对应入口时需要。

本项目采用 PostgreSQL `pg.Pool` 接入，保留 Kysely 和内存适配器，已移除 Prisma、Drizzle、MongoDB 适配器。

## 导入入口

| 入口 | 内容 |
| --- | --- |
| `@app/auth-sdk/server` | `betterAuth` 和服务端类型 |
| `@app/auth-sdk/plugins` | 内置服务端插件 |
| `@app/auth-sdk/client/plugins` | 内置客户端插件 |
| `@app/auth-sdk/react` | `createAuthClient`，含 `useSession` |
| `@app/auth-sdk/next-js` | `toNextJsHandler`、`nextCookies` |
| `@app/auth-sdk/subscription` | `subscription` 通用套餐与订阅插件 |
| `@app/auth-sdk/subscription/client` | `subscriptionClient` |
| `@app/auth-sdk/credits` | `credits` 额度与流水插件 |
| `@app/auth-sdk/credits/client` | `creditsClient` |
| `@app/auth-sdk/stripe` | Stripe 服务端插件 |
| `@app/auth-sdk/stripe/client` | `stripeClient` |
| `@app/auth-sdk/paypal` | PayPal 订单、收款确认与 webhook 验签 |

服务端使用 `betterAuth({ database, secret, baseURL, ... })` 配置认证，再将请求交给 `auth.handler(request)`。会话检查必须传当前请求头：`auth.api.getSession({ headers: request.headers })`。

SDK 不启动 HTTP 服务、不提供页面。密钥与数据库配置留在使用方服务端，数据库表需要预先迁移。PayPal 入口仅供服务端使用，默认沙箱，支持一次性付款，不含自动续费。

PayPal.cn 全球收单的服务端客户端实现在独立的 `@app/paypal` 包中，由 `@app/auth-sdk/paypal` 转发导出 `createPayPalClient`，随完整 SDK 安装包一起分发。配置 `clientId`、`clientSecret`、`webhookId` 后，可以创建订单（`createOrder`）、查询订单（`getOrder`）、确认收款（`captureOrder`）和验证回调（`verifyWebhook`）；正式环境使用 `environment: "live"`。

## 通用订阅

`@app/auth-sdk/subscription` 转发独立包 `@app/subscription`。服务端启用 `subscription({ plans })`，套餐包含 `name`、可选的 `limits` 和 `group`；`plans` 可以是数组或返回数组的异步函数。客户端启用 `subscriptionClient()`。完整配置及与 Stripe 共享套餐的示例见[根目录说明](../../README.md#通用套餐与订阅)。

- `auth.api.listSubscriptionPlans({ headers })`：查询套餐定义。
- `auth.api.listCustomerSubscriptions({ headers, query? })`：默认查询当前用户有效订阅及 `limits`；`activeOnly` 默认 `true`，其他 `referenceId` 需要配置 `authorizeReference`。
- `auth.api.syncSubscription({ body })`：仅供受信服务端同步，包含 `provider`、稳定的 `providerSubscriptionId`、`referenceId`、`plan`、`status`、绝对起止日期及持久化递增的 `revision`，没有 HTTP 写入口。返回 `{ subscription, applied }`；相同或旧版本不更新记录。

支付验签、订单及金额核验、业务副作用去重和 `limits` 的执行由使用方负责。PayPal 一次性付款可用业务端稳定会员授权 ID 同步有效期；重复付款回调应重用原版本和有效期，不等于自动续费。通用插件不包含自动扣款或用量计量。

首次启用需迁移数据库；与 Stripe 共用订阅表时，自定义表名及字段映射必须一致。旧 Stripe 记录需有有效起止日期才能出现在通用权益查询中；迁移前备份，并核对、补齐渠道标识和通用订阅 ID。Stripe 的价格配置和支付 API 继续保留。

## Credits 额度

`@app/auth-sdk/credits` 转发独立包 `@app/credits`。服务端启用 `credits()`，客户端启用从 `@app/auth-sdk/credits/client` 导入的 `creditsClient()`。先迁移数据库；插件依赖 SQL 唯一约束保证并发写入和重复请求不重复记账，支持 PostgreSQL/Kysely，不支持内存适配器。

- `auth.api.grantCredits({ body })`、`auth.api.consumeCredits({ body })`：仅供受信服务端发放和扣减，没有 HTTP 写入口。`body` 包含 `referenceId`、正安全整数 `amount`、`idempotencyKey` 和可选 `reason`；余额不足时拒绝扣减。
- `auth.api.getCreditsBalance({ headers, query? })`：返回 `{ referenceId, balance }`，初始余额为 0。
- `auth.api.listCreditsLedger({ headers, query? })`：返回 `{ entries, nextCursor }`，支持 `cursor`、`limit` 分页。两种查询默认只访问当前用户；其他 `referenceId` 需要配置 `authorizeReference`。
- 浏览器只读入口为 `client.credits.balance()` 和 `client.credits.ledger({ query: { limit: 20 } })`。

写入返回 `{ entry, applied }`。同账户、同 key 的重复操作不重复执行；重试需保持操作、数量和原因一致。超时后重用原 key；`applied: false` 返回原流水及当时余额，当前余额需重新查询。流水只追加，不应直接修改或删除。

额度默认永久累积。包月额度可由业务端在每期付款核验后发放，使用稳定的账单或业务周期 key；套餐 `limits` 不会自动发放额度。插件不执行自动扣款、定时发放或到期清零。额度操作与外部业务不是同一事务，失败任务可用新的稳定 key 发放补偿。示例见[根目录说明](../../README.md#credits-额度)。

## 修改与测试

在源码仓库根目录运行：

```bash
pnpm install --frozen-lockfile
pnpm build:sdk
pnpm test:sdk
pnpm test:packaging
pnpm typecheck
pnpm pack:sdk
```

PayPal 实现和测试分别位于 `packages/paypal/src/index.ts`、`packages/paypal/test/paypal.test.ts`；通用订阅实现在 `packages/subscription/src`，credits 实现在 `packages/credits/src`。`pnpm test:sdk` 同时运行 SDK 入口、独立 PayPal、通用订阅和 credits 包的测试。完整 SDK 安装包会包含这些独立包。

请用根目录 `pack:sdk` 生成完整安装包；直接打包本目录只包含入口层。其他独立插件仍保留在工作区中，可按需构建和接入。
