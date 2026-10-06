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

## 未付款订单有效期

这是**业务订单创建后允许发起付款的时间**，与套餐有效期、积分有效期及网络请求超时无关。所有时间均为 Unix 毫秒时间戳，来自服务端；浏览器提交的 `createdAt`、`expiresAt` 或当前时间不能作为校验依据。时间戳须为 `0` 到 `8_640_000_000_000_000` 范围内的安全整数，计算后的期限也不能超出此 Date 范围。

| 接口 | 行为 |
| --- | --- |
| `orderExpiration` 省略或 `false` | 不要求期限，旧的创建、扣款参数和返回值保持不变 |
| `orderExpiration: true` | 启用，默认 30 分钟 |
| `orderExpiration: { ttlMs }` | 自定义期限；`ttlMs` 必须为 Date 范围内的正安全整数毫秒数 |
| `paypal.calculateOrderExpiresAt(createdAt)` | 根据服务端业务订单创建时间计算期限；未启用时返回 `undefined`，不读取或保存订单 |
| `paypal.assertOrderPayable(expiresAt)` | 到达期限（服务端 `Date.now() >= expiresAt`）即抛错；启用时缺失期限也会拒绝 |
| `createOrder({ ...input, expiresAt })` / `captureOrder({ ...input, expiresAt })` | 接收应用已保存的期限，在请求开始及取得 OAuth token 后、发送付款 POST 前校验 |
| `isPayPalOrderExpiredError(error)` | 识别 `PayPalOrderExpiredError`；错误包含 `code: "PAYPAL_ORDER_EXPIRED"` 和原 `expiresAt` |

无效配置、无效时间或启用后缺少期限属于输入错误，不能当作正常过期处理。显式传入的 `expiresAt` 始终生效，包括配置已关闭的情况，以免配置切换绕过已保存的期限。SDK 不会在重试时自动计算或延长期限，也不会因请求返回时已过期而丢弃扣款结果。

### 应用接入示例

下面的 `orders` 是**应用自己的持久化适配器**，不是 SDK 提供的数据库或服务。示例覆盖创建、恢复、扣款和 webhook；接入时将这些方法接到现有订单系统：

- `insertOnce(userId, checkoutKey, factory)`：在事务/唯一约束保护下，只为新的业务订单执行 `factory` 并保存；重复请求返回原记录。业务幂等键须绑定用户，禁止替换已有时间、价格和 request ID。
- `withOwnedLock(id, userId, fn)` / `withLock(id, fn)`：加载服务端订单并串行处理同一订单。前者还校验当前登录用户所有权；锁必须覆盖多实例并发。所有恢复、扣款、回调和对账入口遵循同一规则。
- `savePayPalOrderId`、`markCaptureStarted`：先持久化平台订单映射/扣款尝试再继续；扣款标记必须在网络请求前提交，避免进程退出后误判为从未扣款。
- `reconcile(local, remote, event?)`：核对 PayPal 订单 ID、单笔购买项的本地 `reference_id` / `custom_id`、币种和金额，并逐笔核验 capture 的金额、币种和状态；不能仅凭订单 `status: "COMPLETED"` 判定已收款。只有确认未付款且没有未解决扣款尝试时，才返回 `{ status: "unpaid" }`。已完成扣款按稳定 capture ID 幂等履约；`PENDING`、结果未知、退款/争议等状态返回相应业务结果，继续对账或进入应用已有退款处理流程。
- `findIdByVerifiedEvent(event)`：通过已验签事件的 PayPal 订单/capture 标识定位已保存的业务订单；未知映射保留待调查并重试，不能直接忽略。回调事件和履约副作用使用持久化唯一键/事务去重；跨服务履约使用应用已有的可靠重试机制。

`checkoutKey` 是应用已有的业务创建幂等键；`userId` 来自服务端认证，价格来自服务端商品配置。以下代码不接受浏览器传入的期限、价格、PayPal 订单 ID 或 request ID。

```ts
import {
  createPayPalClient,
  isPayPalOrderExpiredError,
} from "@app/auth-sdk/paypal";
import { orders } from "./payment-store"; // 上述应用适配器

const paypal = createPayPalClient({
  clientId: process.env.PAYPAL_CLIENT_ID!,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
  webhookId: process.env.PAYPAL_WEBHOOK_ID!,
  orderExpiration: true, // 或 { ttlMs: 15 * 60_000 }
});

async function createBusinessOrder(userId: string, checkoutKey: string) {
  return orders.insertOnce(userId, checkoutKey, () => {
    const createdAt = Date.now();
    return {
      id: crypto.randomUUID(),
      userId,
      createdAt,
      expiresAt: paypal.calculateOrderExpiresAt(createdAt),
      createRequestId: crypto.randomUUID(),
      captureRequestId: crypto.randomUUID(),
      amount: { currency_code: "USD", value: "9.90" },
      captureAttempted: false,
    };
  });
}

// 首次支付与刷新/恢复共用此入口，始终读取已保存的期限和 request ID。
async function resumeCheckout(id: string, userId: string) {
  return orders.withOwnedLock(id, userId, async (local) => {
    let remote = local.paypalOrderId
      ? await paypal.getOrder(local.paypalOrderId)
      : undefined;
    if (remote) {
      const result = await orders.reconcile(local, remote);
      if (result.status !== "unpaid") return result;
    }
    try {
      paypal.assertOrderPayable(local.expiresAt);
      if (!remote) {
        remote = await paypal.createOrder({
          requestId: local.createRequestId,
          referenceId: local.id,
          amount: local.amount,
          returnURL: "https://app.example.com/paypal/return",
          cancelURL: "https://app.example.com/paypal/cancel",
          expiresAt: local.expiresAt,
        });
        await orders.savePayPalOrderId(local.id, remote.id);
      }
      // 仅在仍可支付时向浏览器提供审批链接；倒计时用原 expiresAt。
      paypal.assertOrderPayable(local.expiresAt);
      return { status: "awaiting_approval", order: remote, expiresAt: local.expiresAt };
    } catch (error) {
      if (!isPayPalOrderExpiredError(error)) throw error;
      // 只结束付款窗口，不据此把业务订单终结为「确定未付款」。
      return { status: "payment_window_ended", expiresAt: error.expiresAt };
    }
  });
}

async function capturePayment(id: string, userId: string) {
  return orders.withOwnedLock(id, userId, async (local) => {
    if (!local.paypalOrderId) throw new Error("Missing saved PayPal order ID");
    // 恢复或重试先查平台状态；已付款、pending 或未知结果不再次扣款。
    const remote = await paypal.getOrder(local.paypalOrderId);
    const result = await orders.reconcile(local, remote);
    if (result.status !== "unpaid") return result;
    try {
      paypal.assertOrderPayable(local.expiresAt);
      await orders.markCaptureStarted(local.id);
      local.captureAttempted = true; // 同步传给本次对账的内存记录
      const captured = await paypal.captureOrder({
        orderId: local.paypalOrderId,
        requestId: local.captureRequestId,
        expiresAt: local.expiresAt,
      });
      // 扣款可能在期限前发送、期限后完成；仍需正常对账与履约。
      return await orders.reconcile(local, captured);
    } catch (error) {
      if (!isPayPalOrderExpiredError(error)) throw error;
      // 仅证明本次 SDK 调用未发送付款 POST，不证明之前没有扣款。
      // 保留已保存的尝试记录，供查询/回调继续对账。
      return { status: "payment_window_ended", expiresAt: error.expiresAt };
    }
  });
}

async function handlePayPalWebhook(request: Request) {
  const event = await paypal.verifyWebhook({
    headers: request.headers,
    body: await request.text(), // 保留原始内容供验签，不先解析再序列化
  });
  const id = await orders.findIdByVerifiedEvent(event);
  if (!id) throw new Error("Unmapped PayPal event; preserve and reconcile");
  return orders.withLock(id, async (local) => {
    if (!local.paypalOrderId) throw new Error("Missing saved PayPal order ID");
    const remote = await paypal.getOrder(local.paypalOrderId);
    // 此处不调用 assertOrderPayable，不按 expiresAt 过滤回调。
    return orders.reconcile(local, remote, event);
  });
}
```

`markCaptureStarted` 后遇到超时、网络错误、进程退出或查询尚未反映扣款时，保留不确定状态；不能清空标记后盲目再扣款，也不能仅因没有返回 capture 就改成过期。由应用继续查询、处理回调或人工对账；确需重试时保留原 `captureRequestId`，且新的付款请求仍受原期限约束。创建平台订单结果不确定时也保留原 `createRequestId`，不得换新键重建支付。SDK 不自动重试或修改这些键。

本地付款窗口结束**不代表 PayPal 平台订单已经关闭**，SDK 不提供关闭订单或退款 API。SDK 拦截其创建/扣款调用；应用仍须限制其他付款入口和已恢复的审批链接。对于已发生的扣款，即便本地记录已显示窗口结束，也必须核验并履约，或按应用规则走已有退款流程；不能丢弃延迟回调。查询/验签失败应保留状态并重试，不能转换成「未付款已过期」。

前端从服务端读取 `expiresAt` 展示倒计时即可，例如 `Math.max(0, expiresAt - Date.now())`；客户端时钟、按钮禁用与页面刷新均不影响服务端校验。浏览器回传业务订单 ID 后，服务端重新校验所有权并从数据库读取期限。

### IAMF 接入点与旧订单迁移

1. 服务端 PayPal 初始化启用 `orderExpiration`；仅首次业务订单创建时保存 `createdAt`、`expiresAt`、平台订单映射及独立、稳定的创建/扣款 request ID。
2. 创建支付、恢复订单、PayPal return/capture 路由改为读取服务端订单并传入 `expiresAt`，处理 `PAYPAL_ORDER_EXPIRED`；现有并发控制、扣款尝试记录和幂等键继续使用。
3. 订单查询与前端恢复接口返回保存的期限，前端只负责展示倒计时。付款窗口状态与实际支付/履约状态分开保存。
4. webhook 与对账入口始终验签、查询并核验金额、币种、本地映射及 capture 状态；对已付款、pending、未知结果和延迟通知继续幂等履约或退款。
5. 上线前明确旧订单政策：按原可信业务创建时间一次性回填期限，或显式将无期限旧订单路由到未启用功能的旧客户端。不得以部署、刷新或重试时间重新开始计时。启用客户端对缺少期限的旧订单会拒绝新付款；已有 `expiresAt` 的订单不能通过关闭配置绕过期限。

这些迁移、数据库约束、并发锁及业务状态处理属于 IAMF 等接入应用。本 SDK 仅提供期限计算和付款门禁，不创建业务订单表、定时任务，也不决定何时退款。

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
