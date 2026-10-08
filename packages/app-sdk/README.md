# 认证与支付 SDK

`@app/auth-sdk` 统一导出 Better Auth 服务端、客户端插件、React、Next.js、通用订阅、credits、组合业务、Stripe 和 PayPal 功能，保持各功能包的参数、返回值和类型推导。

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
| `@app/auth-sdk/metrics` | `createMetricsHandler` 站点只读统计接口 |
| `@app/auth-sdk/plugins` | 内置服务端插件 |
| `@app/auth-sdk/client/plugins` | 内置客户端插件 |
| `@app/auth-sdk/react` | `createAuthClient`，含 `useSession` |
| `@app/auth-sdk/next-js` | `toNextJsHandler`、`nextCookies` |
| `@app/auth-sdk/subscription` | `subscription` 通用套餐与订阅插件 |
| `@app/auth-sdk/subscription/client` | `subscriptionClient` |
| `@app/auth-sdk/credits` | `credits` 额度与流水插件 |
| `@app/auth-sdk/credits/client` | `creditsClient` |
| `@app/auth-sdk/business` | `business` 组合业务、订单履约与后台 API；支付适配类型 |
| `@app/auth-sdk/business/client` | `businessClient` 购买与管理员客户端入口 |
| `@app/auth-sdk/stripe` | Stripe 服务端插件 |
| `@app/auth-sdk/stripe/client` | `stripeClient` |
| `@app/auth-sdk/paypal` | PayPal 订单、收款确认与 webhook 验签 |

服务端使用 `betterAuth({ database, secret, baseURL, ... })` 配置认证，再将请求交给 `auth.handler(request)`。会话检查必须传当前请求头：`auth.api.getSession({ headers: request.headers })`。

SDK 包本身不启动 HTTP 服务，管理页面由仓库中的 `apps/dashboard` 应用提供。密钥与数据库配置留在使用方服务端，数据库表需要预先迁移。PayPal 入口仅供服务端使用，默认沙箱，支持一次性付款，不含自动续费。

PayPal.cn 全球收单的服务端客户端实现在独立的 `@app/paypal` 包中，由 `@app/auth-sdk/paypal` 转发导出 `createPayPalClient`，随完整 SDK 安装包一起分发。配置 `clientId`、`clientSecret`、`webhookId` 后，可以创建订单（`createOrder`）、查询订单（`getOrder`）、确认收款（`captureOrder`）和验证回调（`verifyWebhook`）；正式环境使用 `environment: "live"`。

## Dashboard 接入

仓库中的 [apps/dashboard](../../apps/dashboard/README.md) 是基于指定模板的 Next.js 管理后台，保留原排版、配色、横向 Tabs、图表和弹窗动效，包含概览、用户与会话、套餐、订单、会员、积分和操作记录。它使用 `@app/auth-sdk/react`、`adminClient()` 与 `businessClient()` 调用真实接口；页面源码不随 `auth-sdk.tgz` 分发。

本地从仓库根目录运行 `pnpm build:sdk`，复制 `apps/dashboard/.env.example` 为 `apps/dashboard/.env.local`，填写密钥、数据库、初始管理员及 `BETTER_AUTH_URL=http://127.0.0.1:3001`，然后执行 `pnpm dashboard:setup` 和 `pnpm dashboard:dev`。初始化命令会迁移表并创建新管理员，访问地址为 `http://127.0.0.1:3001`；具体配置和生产数据库要求见应用说明。

迁入已有网站时，复用 `apps/dashboard/components` 中的面板，将 `apps/dashboard/lib/auth.ts` 的 `getAuth()` 接到网站现有认证实例，在 `lib/auth-client.ts` 复用同源认证路由，并为该实例启用 `admin({ auditLog: true })`、`subscription({ catalog: true })`、`credits()` 和 `business({ providers })`。管理员和网站用户共用同一数据库，已有 `/api/auth` 路由无需重复创建。保留网站原有注册策略和服务端权限校验；支付适配器、付款及退款核验仍由网站可信服务端配置。

## SEO-worker 站点统计

`createMetricsHandler` 返回原生 `(request: Request) => Promise<Response>` 处理函数，由网站挂载一个服务端路由，例如 `/internal/metrics`。接口只接受不带查询参数的 GET 请求，通过 `Authorization: Bearer <凭证>` 鉴权，不使用登录 Cookie，不返回用户明细。所有响应设置 `Cache-Control: no-store`；SDK 内部的短期快照缓存不属于 HTTP 缓存。

第一期按独立网站数据库统计。`siteId` 是输出标签，不是租户查询条件；多个网站共用用户库时不能用不同 `siteId` 获取各站用户数，须先提供有明确站点归属过滤的统计实现。

### 环境变量与挂载

| 网站服务端环境变量 | 规则 |
| --- | --- |
| `APP_METRICS_ENABLED` | 只有精确字符串 `true` 启用；默认关闭，处理函数返回 404 |
| `APP_METRICS_SITE_ID` | 启用时必填，1～128 个英文字母、数字、`_` 或 `-` |
| `APP_METRICS_TOKEN` | 启用时必填，32～256 个英文字母、数字、`_` 或 `-`；独立、密码学安全随机生成的服务凭证 |
| `APP_METRICS_RATE_LIMIT_PER_MINUTE` | 可选，1～60 的整数，默认 6；限制每分钟已授权请求数，缓存命中也计数 |

凭证仅保存于网站和 SEO-worker 服务端，不使用 `NEXT_PUBLIC_` 等会暴露给浏览器的环境变量，不复用 `BETTER_AUTH_SECRET`。可以通过 `crypto.getRandomValues(new Uint8Array(32))` 生成 32 字节随机数，再编码成 64 位十六进制字符串。只满足长度限制的人工密码不等于随机凭证。轮换时更新网站和 SEO-worker 两侧配置并重新创建处理函数。

启用后无效配置或缺少 `countPaidUsers` 回调会在初始化时抛错；关闭时不会运行统计查询。SDK 显式接收 `env`，不自行读取进程环境；Node.js 可传 `process.env`，Cloudflare Workers 可传服务端环境绑定。

```ts
// 使用方应用：app/internal/metrics/route.ts
import { createMetricsHandler } from "@app/auth-sdk/metrics";
import { auth } from "@/lib/auth";
import { countPaidUsers } from "@/lib/payment-metrics"; // 应用实现，见下方约定

export const GET = createMetricsHandler({
  env: process.env,
  auth,
  countPaidUsers,
});
```

每个网站、每个运行实例只创建一次处理函数并重复使用；在请求内重新创建会重置限流、缓存和并发保护。其他框架将请求交给同一个处理函数并完整返回其 `Response`。

### 指标与付款查询

| 返回字段 | 口径 |
| --- | --- |
| `totalUsers` | 认证数据库当前存在的用户总数 |
| `newUsers7d` | 当前存在且 `createdAt` 落在最近 7 × 24 小时 `[from, to)` 的用户数；不保留已注销用户的历史注册量 |
| `paidUsersThisMonth` | UTC 当月月初至本次统计时间 `[from, to)` 内已成功付款的去重用户数，由应用付款查询回调提供 |

`countPaidUsers({ from, to, signal })` 是应用提供的异步函数；`from`、`to` 为 `Date`，`signal` 为 `AbortSignal`，返回 `Promise<number>`，结果须为非负安全整数。PostgreSQL 驱动返回字符串计数时，应用需先转换并校验数字。查询须使用参数化条件，按可信付款完成时间限制 `[from, to)`，只统计经过服务端验签、订单归属及金额核验后持久化的成功付款，金额大于零，并按用户 ID 去重。退款政策由该回调决定，必须与后台展示口径一致；例如“本月成功付过款人数”可以保留之后退款的用户，“当前仍有净付款人数”则需排除已全额退款记录。统计 handler 本身不创建订单表，也不把试用或有效订阅算成成功付款；启用下文 `business` 后，可用其已核验订单实现该查询，仍须按传入区间统计。

将 `signal` 传给支持取消的查询或下游客户端，并在数据库设置有限的语句执行超时及连接池上限。不要先拉取全部订单或全部用户到应用内计数。

响应包含站点、统计时间和两个准确的统计区间，日期序列化为 ISO 8601 UTC 字符串：

```json
{
  "siteId": "my_site",
  "generatedAt": "2026-10-07T04:00:00.000Z",
  "timezone": "UTC",
  "totalUsers": 1200,
  "newUsers7d": 37,
  "paidUsersThisMonth": 18,
  "periods": {
    "newUsers": {
      "from": "2026-09-30T04:00:00.000Z",
      "to": "2026-10-07T04:00:00.000Z"
    },
    "paidUsers": {
      "from": "2026-10-01T00:00:00.000Z",
      "to": "2026-10-07T04:00:00.000Z"
    }
  }
}
```

### 限流与服务保护

- 每个处理函数有鉴权前的固定限流：每分钟最多 60 次尝试，错误凭证也计入；通过鉴权后还受默认每分钟 6 次的限制。限额按整个站点处理函数计算，不依据客户端传入的 IP 创建桶。
- 超限返回 429 和 `Retry-After`。仅保留一份 60 秒统计快照，跨 UTC 月份不复用上月快照；每实例只允许执行一批统计查询，忙碌时返回 503，避免并发请求放大数据库负载。
- 统计响应最多等待 5 秒。查询失败或超时统一返回 503，退避 60 秒，不返回底层错误或伪造的零值。底层查询尚未结束时继续保留并发锁，防止超时后立即启动新批次；**响应超时不保证数据库查询取消**，数据库语句超时和有限连接池仍须由接入应用配置。
- 多实例或无服务器部署不能依赖进程内计数实现全站限流。传入 `rateLimitStorage`，使用现有 `BetterAuthRateLimitStorage` 契约的原子 `consume(key, { window, max })` 实现，或在入口网关统一限流。共享存储在每次已授权请求读取缓存或查库之前执行，存储故障返回 503；不能用非原子的读取再写入代替。共享存储不会合并各实例的缓存或并发锁。

公网部署还需在接入网关限制该路由的连接数和请求速率，防止流量在抵达 SDK 前就耗尽服务资源。不同网站使用独立站点 ID、凭证和处理函数，统计凭证不授予任何写入权限。

### SEO-worker 调用约定

SEO-worker 保存 `siteId → HTTPS 接口 URL、服务凭证` 的服务端配置，使用已登记地址发送 `Authorization: Bearer <凭证>`，不从浏览器接受任意目标 URL 或向浏览器返回凭证。建议每 1～5 分钟采集一次或按需刷新；遇到 429/503 遵循 `Retry-After` 退避，保留最后成功结果及其 `generatedAt` 并标明暂时不可用，不把请求失败显示成用户数为零。

SDK 不会自动注册到 SEO-worker、推送数据或创建采集定时任务。SEO-worker 接入只需登记该网站的地址和凭证，再读取上述三个字段。

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

本地付款窗口结束**不代表 PayPal 平台订单已经关闭**，PayPal 客户端不提供关闭渠道订单或发起退款 API。SDK 拦截其创建/扣款调用；应用仍须限制其他付款入口和已恢复的审批链接。对于已发生的扣款，即便本地记录已显示窗口结束，也必须核验并履约，或按应用规则走已有退款流程；不能丢弃延迟回调。查询/验签失败应保留状态并重试，不能转换成「未付款已过期」。

前端从服务端读取 `expiresAt` 展示倒计时即可，例如 `Math.max(0, expiresAt - Date.now())`；客户端时钟、按钮禁用与页面刷新均不影响服务端校验。浏览器回传业务订单 ID 后，服务端重新校验所有权并从数据库读取期限。

### IAMF 接入点与旧订单迁移

1. 服务端 PayPal 初始化启用 `orderExpiration`；仅首次业务订单创建时保存 `createdAt`、`expiresAt`、平台订单映射及独立、稳定的创建/扣款 request ID。
2. 创建支付、恢复订单、PayPal return/capture 路由改为读取服务端订单并传入 `expiresAt`，处理 `PAYPAL_ORDER_EXPIRED`；现有并发控制、扣款尝试记录和幂等键继续使用。
3. 订单查询与前端恢复接口返回保存的期限，前端只负责展示倒计时。付款窗口状态与实际支付/履约状态分开保存。
4. webhook 与对账入口始终验签、查询并核验金额、币种、本地映射及 capture 状态；对已付款、pending、未知结果和延迟通知继续幂等履约或退款。
5. 上线前明确旧订单政策：按原可信业务创建时间一次性回填期限，或显式将无期限旧订单路由到未启用功能的旧客户端。不得以部署、刷新或重试时间重新开始计时。启用客户端对缺少期限的旧订单会拒绝新付款；已有 `expiresAt` 的订单不能通过关闭配置绕过期限。

以上是单独使用 PayPal 客户端时的接入约定：它不创建业务订单表、定时任务，也不决定何时退款。接入应用可以自行实现订单流程，或使用下文 `business` 及现成的 `createPayPalBusinessProvider` 连接订单、履约和付款核验。

## 通用订阅

`@app/auth-sdk/subscription` 转发独立包 `@app/subscription`。服务端启用 `subscription({ plans })`，套餐包含 `name`、可选的 `limits` 和 `group`；`plans` 可以是数组或返回数组的异步函数。客户端启用 `subscriptionClient()`。完整配置及与 Stripe 共享套餐的示例见[根目录说明](../../README.md#通用套餐与订阅)。

需要可编辑商品目录时启用 `subscription({ catalog: true })`；也可同时提供旧式 `plans`。目录提供不可变商品版本，支持纯积分 `credits`、纯会员 `membership`、会员加积分 `bundle`。受信服务端可调用 `createProductService(adapter)` 的 `save/get/getLatest/list/setPublished`，或 `auth.api.saveSubscriptionProduct({ body })`、`auth.api.publishSubscriptionProduct({ body })`；后两个为 server-only，不是管理员浏览器写入口。管理员页面使用下文 `business` 的鉴权、审计接口。

目录商品使用独立版本 ID 作为权益引用，修改、上下架不会改变已购买版本。旧式 `plans` 仍按名称查询当前配置，其同名 `limits` 修改会影响现有订阅查询；不要把旧配置模式误当成权益快照。`limits` 是业务配置，实际限制项目数、功能访问或调用次数仍由网站执行。

- `auth.api.listSubscriptionPlans({ headers })`：查询套餐定义。
- `auth.api.listCustomerSubscriptions({ headers, query? })`：默认查询当前用户有效订阅及 `limits`；`activeOnly` 默认 `true`，其他 `referenceId` 需要配置 `authorizeReference`。
- `auth.api.syncSubscription({ body })`：仅供受信服务端同步，包含 `provider`、稳定的 `providerSubscriptionId`、`referenceId`、`plan`、`status`、绝对起止日期及持久化递增的 `revision`，没有 HTTP 写入口。返回 `{ subscription, applied }`；相同或旧版本不更新记录。

支付验签、订单及金额核验、业务副作用去重和 `limits` 的执行由使用方负责。PayPal 一次性付款可用业务端稳定会员授权 ID 同步有效期；重复付款回调应重用原版本和有效期，不等于自动续费。通用插件不包含自动扣款或用量计量。

首次启用需迁移数据库；与 Stripe 共用订阅表时，自定义表名及字段映射必须一致。旧 Stripe 记录需有有效起止日期才能出现在通用权益查询中；迁移前备份，并核对、补齐渠道标识和通用订阅 ID。Stripe 的价格配置和支付 API 继续保留。

## Credits 额度

`@app/auth-sdk/credits` 转发独立包 `@app/credits`。服务端启用 `credits()`，客户端启用从 `@app/auth-sdk/credits/client` 导入的 `creditsClient()`。先迁移数据库；插件依赖 SQL 唯一约束保证并发写入和重复请求不重复记账，支持 PostgreSQL/Kysely，不支持内存适配器。

- `auth.api.grantCredits({ body })`、`auth.api.consumeCredits({ body })`：仅供受信服务端发放和扣减，没有 HTTP 写入口。共有字段为 `referenceId`、正安全整数 `amount`、`idempotencyKey` 和可选 `reason`；发放还接受可选 `source` 和 `expiresAt: Date`，每次发放为独立批次。余额不足时拒绝扣减。
- `auth.api.revokeCreditsGrant({ body })`：受信服务端按 `referenceId`、原发放 `grantKey`、本次 `idempotencyKey` 和可选 `reason`，回收该批次尚未消费且未过期的积分。返回 `{ entry, applied, recovered, unavailable }`；`unavailable` 包含已消费或已过期而无法回收的数量，不会扣其他批次。
- `auth.api.getCreditsBalance({ headers, query? })`：返回 `{ referenceId, balance }`，初始余额为 0。
- `auth.api.listCreditsLedger({ headers, query? })`：返回 `{ entries, nextCursor }`，支持 `cursor`、`limit` 分页。两种查询默认只访问当前用户；其他 `referenceId` 需要配置 `authorizeReference`。
- 浏览器只读入口为 `client.credits.balance()` 和 `client.credits.ledger({ query: { limit: 20 } })`。

发放/消费返回 `{ entry, applied }`。同账户、同 key 的重复操作不重复执行；重试需保持操作、数量、原因及发放来源/有效期一致，否则报冲突。超时后重用原 key；`applied: false` 返回原流水及当时余额，当前余额需重新查询。流水只追加，不应直接修改或删除。

不传 `expiresAt` 的积分默认永久累积；到期批次在 `now >= expiresAt` 时不可消费。余额/流水查询或新操作会先结算过期批次并追加 `expire` 流水，因此查询可能产生这类系统记账。消费优先扣最早到期批次，同到期时间优先较早发放批次，永久积分最后消费。不会因为会员到期而清空整个账户，也不会清掉另一笔充值。

升级须迁移新增批次字段并保留原唯一约束；旧流水按永久积分恢复批次，不回写历史行。业务组合可将 `createCreditsService(transactionAdapter)` 与会员、订单、审计写入同一事务；单独调用积分 API 与外部任务或支付平台之间没有跨系统事务。插件不创建定时发放任务，套餐 `limits` 也不自动发放积分。示例见[根目录说明](../../README.md#credits-额度)。

## 组合业务与后台接口

`business` 是一层可选组合插件，复用现有认证、Admin、商品目录、订阅和积分能力。它提供网站的购买、订单履约、查询及管理员 API。现有 Stripe、PayPal 包各自提供支付适配器；仓库的 [Dashboard](../../apps/dashboard/README.md) 已通过环境变量接入任选一个渠道及 SMTP 邮件，无需另建插件。

### 启用与迁移

```ts
import { betterAuth } from "@app/auth-sdk/server";
import { admin } from "@app/auth-sdk/plugins";
import { subscription } from "@app/auth-sdk/subscription";
import { credits } from "@app/auth-sdk/credits";
import { business } from "@app/auth-sdk/business";
import { database } from "./database"; // 网站提供的真实 SQL 连接/事务适配器
import { paymentProviders } from "./payment-providers"; // 用下文现成适配器配置

export const auth = betterAuth({
  database,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  plugins: [
    admin({ auditLog: true }),
    subscription({ catalog: true }),
    credits(),
    business({ providers: paymentProviders, orderTtlMs: 60 * 60_000 }),
  ],
});
```

`business` 初始化检查这三个基础插件及其开关，并要求数据库适配器启用真实 SQL 事务和唯一约束。直接接入的 PostgreSQL、SQLite 可用；自定义 Kysely 适配器须启用真实事务，不能用顺序执行模拟。内存适配器和没有交互事务的 D1 不支持此组合插件。鉴权及数据库仍属于网站，SDK 不另起服务。

按完整认证配置生成并应用迁移：启用目录新增 `subscriptionProduct`；审计新增 `adminAuditLog`；业务新增 `businessOrder`、`businessCustomer`、`businessPaymentEvent`、`businessAction`；积分表增加 `kind/source/expiresAt/batchState/revokedGrantKey` 五列。本次 `subscription.revision` 改为 bigint，已有表须检查并迁移该列类型。保留订阅同步键、商品版本、付款事件、管理员操作、积分流水及审计事件的唯一约束。已有数据先备份，在测试库确认迁移；不要通过直接更新余额或删除历史记录迁移。关闭 `auditLog` 不自动删除已存在的审计表。

当前组合业务集成测试使用 SQLite 和模拟支付适配器，不代表已经完成真实支付或多数据库联调。部署到 PostgreSQL 时验证目标库的事务和唯一约束；跨层并发遇到唯一冲突会回滚本次事务，应保留同一操作/购买 ID 重试整个调用，不能捕获错误后继续提交半个事务。渠道调用超时也保留原幂等键并回查，不能据此再次创建付款。

网站已有数据库、认证路由、登录方式与回调继续复用；示例中的 `database` 和 `paymentProviders` 是应用模块，不是 SDK 隐式创建的对象。浏览器端按需注册：

```ts
import { createAuthClient } from "@app/auth-sdk/react";
import { adminClient } from "@app/auth-sdk/client/plugins";
import { businessClient } from "@app/auth-sdk/business/client";
import { subscriptionClient } from "@app/auth-sdk/subscription/client";
import { creditsClient } from "@app/auth-sdk/credits/client";

export const authClient = createAuthClient({
  plugins: [
    adminClient({ auditLog: true }),
    businessClient(),
    subscriptionClient(),
    creditsClient(),
  ],
});
```

### 三类商品与不可变版本

| `type` | 购买效果 | 必需字段 |
| --- | --- | --- |
| `credits` | 发放一批积分 | `credits > 0`，`membershipDays: null` |
| `membership` | 授予会员权益，不发积分 | `membershipDays > 0`，`credits: 0`，`creditValidityDays: null` |
| `bundle` | 授予会员并发放积分 | `membershipDays > 0`，`credits > 0` |

商品包含稳定业务 `key`、名称、币种、整数金额、`limits`、上架状态和可选 `creditValidityDays`。金额统一按该币种的最小货币单位存储；例如 USD 的 `1000` 表示 USD 10.00，渠道适配器负责正确转换，不能用浮点金额计算。付费 checkout 要求金额大于零。`membershipDays` 和 `creditValidityDays` 均按每一天 24 小时计算，`30` 天不等于自然月。

`expectedVersion: 0` 表示新建；编辑/上下架传当前版本，冲突时刷新后重做。每次操作创建新版本，新购买只接受当前上架的最新版本 ID；已有订单保留商品、价格和权益快照，历史会员继续引用原版本。没有删除商品历史的接口。通过管理员请求保存商品：

```ts
const product = await auth.api.saveBusinessProduct({
  headers: request.headers, // 当前管理员会话
  body: {
    operationId: "catalog-pro-create-1", // 同一次操作重试复用
    reason: "发布 Pro 会员套餐",
    product: {
      key: "pro",
      expectedVersion: 0,
      name: "Pro 30 天",
      type: "bundle",
      amount: 1000,
      currency: "USD",
      membershipDays: 30,
      credits: 100,
      creditValidityDays: 30,
      limits: { projects: 10 },
      published: true,
    },
  },
});
```

不填 `creditValidityDays` 时本次赠送永久有效；填写时以**可信付款时间**计算该批次到期时间，与会员有效期分别管理。后台变更赠送规则不会追溯修改已发放批次。当前续费沿用原购买快照及金额；调价或迁移老订阅需要应用单独设计渠道与权益迁移流程。

### 支付适配器契约

`paymentProviders` 的类型为从 `@app/auth-sdk/business` 导入的 `Record<string, BusinessPaymentProvider>`。对象的键是下单时使用的 `provider`。可选择以下现成适配器；密钥和回调地址只在服务器配置：

```ts
// payment-providers.ts：Stripe 方案，需要安装 stripe peer dependency。
import Stripe from "stripe";
import { createStripeBusinessProvider } from "@app/auth-sdk/stripe";

export const paymentProviders = {
  stripe: createStripeBusinessProvider({
    stripeClient: new Stripe(process.env.STRIPE_SECRET_KEY!),
    returnURL: "https://example.com/payment/return",
    cancelURL: "https://example.com/pricing",
  }),
};
```

```ts
// 或使用 PayPal，替换上面的配置。
import { createPayPalClient, createPayPalBusinessProvider } from "@app/auth-sdk/paypal";

export const paymentProviders = {
  paypal: createPayPalBusinessProvider({
    client: createPayPalClient({
      clientId: process.env.PAYPAL_CLIENT_ID!,
      clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
      webhookId: process.env.PAYPAL_WEBHOOK_ID!,
      environment: "sandbox", // 正式收款使用 live 及相应凭据
      orderExpiration: true,
    }),
    returnURL: "https://example.com/payment/return",
    cancelURL: "https://example.com/pricing",
  }),
};
```

这两个适配器销售一次性商品：积分、指定天数会员或组合套餐；会员商品不等于自动续费订阅。Stripe 在创建 checkout 时要求订单至少剩余 30 分钟，建议 `orderTtlMs: 60 * 60_000`，剩余不足时应创建新购买操作。PayPal 在捕获前回查归属和金额，并使用原订单期限及稳定幂等键；已完成付款允许过期后对账。PayPal 按支持币种转换最小单位，HUF/TWD 要求整单位价格。现成适配器未实现 `verifyRefund`，退款核对需另接可信退款查询；不提供发起退款接口。

目录金额按 ISO 4217 最小单位存储，不能使用浏览器地区习惯的四舍五入位数解释价格。Stripe 适配器处理 ISK/UGX 和 MGA 的渠道单位差异，拒绝非整单位 MGA 及尚未支持的三/四位小数币种。已有 HUF、MGA 等商品若曾通过旧版面板录入，应在启用收款前核对价格；此修改不会重写历史订单金额。

如果需要其他已有渠道，可实现下述契约：

| 方法 | 应用必须完成的工作 |
| --- | --- |
| `createCheckout(order)` | 从已保存订单读取用户、金额、币种和商品；复用 `order.id` 作为渠道幂等键；返回稳定 `providerOrderId` 与 HTTPS `url`。不从浏览器接受价格或支付 URL |
| `verifyPayment({ order, reference })` | 根据可信渠道记录查询已完成付款，验证其确属当前商户、用户和本地订单/渠道订单映射；返回 `paymentId`、`providerOrderId`、整数 `amount`、`currency`、`paidAt: Date`，周期付款还返回成对的绝对 `periodStart/periodEnd` |
| `verifyRefund({ order, reference })`（可选） | 核验一笔已经完成、属于该订单付款的退款，返回 `refundId`、`paymentId`、整数 `amount`、`currency`、`refundedAt: Date`；不负责发起退款 |

渠道通知入口必须校验签名，并结合渠道回查核对商户、订单归属、用户、金额、币种和实际收款状态。`reference` 只是供服务端检索的渠道交易/通知标识，不是“已经付款”的证明；不得把浏览器返回参数或未验签 webhook 原样变成 `VerifiedPayment`。业务插件会进一步比对已存 `providerOrderId`、金额、币种、付款 ID 和时间，但无法替适配器证明外部交易真实性。

现成适配器已复用 PayPal Orders 和 Stripe Checkout；原 Stripe 订阅生命周期和 Billing Portal API 保持不变。Webhook 路由由宿主应用挂载，Dashboard 提供 `/api/payments/webhook`，先验签再回查付款，不依赖用户一定返回成功页面。

### 下单、付款与履约

普通用户可查询已上架商品、创建自己的订单并取得结账链接；用户 ID 来自可信会话：

```ts
const order = await auth.api.createBusinessOrder({
  headers: request.headers,
  body: {
    productId: selectedProductId, // 当前上架版本 ID，服务端重新校验
    provider: selectedProvider,
    idempotencyKey: purchaseAttemptId, // 首次生成后保存，同次购买重试复用
  },
});
const checkout = await auth.api.checkoutBusinessOrder({
  headers: request.headers,
  body: { orderId: order.id },
});
// checkout.checkoutURL 是渠道返回并经服务端校验的地址；非 pending 订单先展示其状态。
```

本地订单默认 30 分钟后不能再发起 checkout，可用 `orderTtlMs` 调整新订单期限。重试不重算期限，也不因修改商品而改价格；并发创建 checkout 依赖适配器复用同一个渠道幂等键。已付款、结果未知或延迟通知继续核验，超过本地期限不代表平台已取消订单。

浏览器注册 `businessClient()` 后可直接调用统一接口，无需传金额或渠道付款凭据：

```ts
const { data: channels } = await authClient.business.providers();
const { data: products } = await authClient.business.products();
// 使用当前商品版本和 channels.providers 中的渠道；purchaseAttemptId 持久化后重试复用。
const { data: order, error } = await authClient.business.orders.create({
  productId: selectedProductId,
  provider: selectedProvider,
  idempotencyKey: purchaseAttemptId,
});
if (error) throw new Error(error.message);
const { data: checkout, error: checkoutError } = await authClient.business.orders.checkout({ orderId: order.id });
if (checkoutError) throw new Error(checkoutError.message);
if (checkout.status === "pending" && checkout.checkoutURL) window.location.assign(checkout.checkoutURL);
// 渠道返回网站后，以原登录会话查询。orderId 只用于选订单，服务端重新核验渠道。
await authClient.business.orders.complete({ orderId: order.id });
```

`completeBusinessOrder`（POST `/business/orders/complete`）只允许查询当前用户的订单，使用服务器保存的渠道订单号核验、履约；失败后保留原订单重试。它不能由浏览器指定付款 ID、金额或把订单直接标记为成功。没有登录时应先恢复原购买账号会话。

底层付款确认仍仅供受信服务端执行，没有对应浏览器/HTTP 写入口：

```ts
// 网站已验签的通知处理器或可信对账任务。
// localOrderId 从服务端保存的渠道映射解析；paymentReference 交给适配器回查。
await auth.api.confirmBusinessPayment({
  body: { orderId: localOrderId, reference: paymentReference },
});
```

确认时先保存可信付款事件与 `paid` 状态，再履约：会员授予、积分发放、`fulfilled` 状态和成功审计在同一个真实 SQL 事务提交。履约失败回滚这部分，付款事实保留，管理员可重试，不能重新扣用户一次钱。已完成订单重复确认/重试不重复发会员或积分。同一付款事件不能用于另一订单或不同载荷。

会员首次有效期默认从付款时间开始；未提供渠道账期的再次购买，会把**同一商品 `key`**（包括后续版本）的有效期接到已记录权益之后，新时段使用本次购买版本的权益。渠道返回绝对账期时使用该账期。积分仍在该笔付款履约时发放，按付款时间计算自身期限；预付续期不会把赠送积分延后到会员起始日。

### 实际续费通知与退款核对

已有支付集成产生新的真实续费收款后，调用：

```ts
await auth.api.confirmBusinessRenewal({
  body: { orderId: originalOrderId, reference: renewalPaymentReference },
});
await auth.api.confirmBusinessRefund({
  body: { orderId: refundedOrderId, reference: completedRefundReference },
});
```

两者同样为 server-only。续费核验须返回新的 `paymentId`、原订单的 `providerOrderId` 映射、匹配金额/币种及明确账期，重复通知复用原渠道交易 ID。插件为这笔续费建立关联子订单并履约，因此月付会员每次实际付款后发一次本期积分；没有付款不能仅凭 `subscription.updated` 或活跃状态发放。固定天数会员并不自动开启渠道自动续费；年付后每月定时赠送积分、主动发起周期扣款均不在此实现内。

退款方法核对**已经完成的退款**，不会向用户发起退款。全额退款取消该订单授予的会员，并仅回收该订单积分批次尚未使用且未过期的余额；不会扣其他充值或赠送。部分退款不自动按比例撤销权益，标记 `reviewRequired: true`；全退时若积分已消费或过期导致无法完整回收，也标记人工复核。不要把这个标记理解为退款未完成，渠道资金退款与本地权益核对是两件事。人工处理按业务政策决定补偿/调整，当前没有通用“一键解决复核”接口。

### 后台查询与人工操作

所有管理接口要求当前 `headers`，重新读取可信会话，拒绝被封禁账户及模拟登录会话。默认允许 Admin 配置的 `adminRoles`（默认 `admin`）或 `adminUserIds`；提供 `business({ authorize })` 后由该回调按 `permission` 明确授权，不能仅通过隐藏按钮控制权限。普通用户接口仅访问自己的订单。

下表均为 `auth.api` 方法；括号内为客户端注册 `businessClient()` 后使用的相对路由，挂在网站认证 base path 下。

| 方法 | 输入与用途 |
| --- | --- |
| `listBusinessProducts`（GET `/business/products`） | 普通用户查询上架商品，`query: { limit?, offset? }` |
| `listBusinessProviders`（GET `/business/providers`） | 当前已启用的渠道名称，不包含密钥 |
| `completeBusinessOrder`（POST `/business/orders/complete`） | `body: { orderId }`，重新核验并履约当前用户的订单 |
| `listOwnBusinessOrders`（GET `/business/orders`） | 当前用户订单，`query: { limit?, offset? }` |
| `listBusinessCatalog`（GET `/business/admin/products`） | 管理员查询各商品最新版本，包含下架商品 |
| `saveBusinessProduct`（POST `/business/admin/products/save`） | `body: { operationId, reason, product }`，保存完整新版本 |
| `publishBusinessProduct`（POST `/business/admin/products/publish`） | `body: { operationId, reason, key, expectedVersion, published }`，上下架也创建新版本 |
| `listBusinessOrders`（GET `/business/admin/orders`） | `query: { referenceId?, status?, limit?, offset? }` |
| `retryBusinessFulfillment`（POST `/business/admin/orders/retry`） | `body: { orderId }`，仅重试已确认付款的订单，订单 ID 本身为重试标识 |
| `getBusinessCustomer`（GET `/business/admin/customer`） | `query: { referenceId }`，用户基础信息、会员、可用积分和首批订单；更多订单用订单列表分页 |
| `listBusinessSubscriptions`（GET `/business/admin/subscriptions`） | `query: { referenceId?, status?, limit?, offset? }`，订阅记录及历史状态 |
| `getBusinessLedger`（GET `/business/admin/credits/ledger`） | `query: { referenceId, limit?, cursor? }`，不可变积分流水 |
| `adjustBusinessCredits`（POST `/business/admin/credits/adjust`） | `body: { operationId, referenceId, action: "grant" \| "consume", amount, reason, expiresAt? }`；只有发放可设到期时间 |
| `adjustBusinessMembership`（POST `/business/admin/membership/adjust`） | `body: { operationId, referenceId, productId, status: "active" \| "canceled", periodStart, periodEnd, reason, subscriptionId?, expectedRevision? }` |
| `listBusinessAuditLogs`（GET `/business/admin/audit`） | `query: { actorId?, targetId?, limit?, offset? }` |
| `getBusinessOverview`（GET `/business/admin/overview`） | 用户总数、近 7 天注册数、UTC 当月付费人数及 `paymentsConfigured`；付款仅统计经业务插件确认的订单，包含之后退款的付款 |

分页查询建议显式传 `limit: 20, offset: 0`，业务 HTTP 列表的 `limit` 最大 100；积分流水改用 `nextCursor` 分页。返回的订阅 `status` 是存储状态，判断当前权益还须检查起止时间；`active` 标签本身不代表当前可用。`paymentsConfigured: false` 表示当前未配置支付适配器，付费统计仍保留已记录历史值（没有历史时为 0），面板应同时展示配置状态。

人工操作在同一事务保存结果和审计。`operationId` 在同一操作者下唯一；同一操作超时重试必须复用原 ID、原因和载荷，改内容则返回冲突，应生成新的操作 ID。充值/扣减金额都传正整数，以 `action` 决定方向。会员编辑现有记录时须传 `subscriptionId` 与查询到的 `expectedRevision`，冲突后刷新；只允许修改 `provider: "business"` 的会员，Stripe 等渠道管理的订阅继续走原渠道 API。人工开通/延长会员不会自动发放组合商品积分，要补积分时调用独立的积分调整并写明原因。

通过人工操作封装的商品保存、上下架、积分调整和会员调整结果统一为可保存的 JSON 值：日期为 ISO 字符串，首次执行与幂等重放结构相同。`BusinessOrder.product.createdAt` 也为快照中的 ISO 字符串；其他顶层日期在服务端方法返回时仍为 `Date`，经 HTTP JSON 传输后为字符串。表单提交会员起止时间/人工积分期限可用 `Date` 或带时区的 ISO 日期字符串。

### 审计读取与保留

单独开启 `admin({ auditLog: true })` 后，可用 `auth.api.listAuditLogs({ headers, query? })` 或 `authClient.admin.auditLogs({ query? })`（GET `/admin/audit-logs`）读取。它使用 Admin 的 `audit: ["list"]` 资源权限，默认管理员拥有；自定义角色需配置相应权限。这与业务接口的 `audit:read` 授权是两个入口。

受信服务端也可从 `@app/auth-sdk/plugins` 导入 `createAdminAuditService(adapter)`，调用 `record({ operationId, actorId, action, targetId, reason, status, details? })` 和 `list({ limit, offset, actorId?, targetId? })`。`status` 为 `started/succeeded/failed`；同一操作/状态同载荷返回原事件，不同载荷冲突。`details` 只接受有界 JSON 数据，拒绝密码、token、API key 等敏感字段名；所有字段均不得放凭证或完整请求体。helper 本身是可信服务端能力，不替调用者鉴权。

原 Admin 管理写接口自动记录请求开始与正常/API 错误结果；终态写入失败或进程中断会留下 `started`，表示结果待核查，不能认定业务未执行。无会话的可信服务端 `createUser` 调用需自行记录。业务插件将成功审计与本地变更放在同一事务，异常回滚不会留下虚假的成功。审计只追加、无修改/删除 API，保留用户删除后的历史；数据库权限与备份仍由网站管理。

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

PayPal 实现和测试分别位于 `packages/paypal/src/index.ts`、`packages/paypal/test/paypal.test.ts`；通用订阅实现在 `packages/subscription/src`，credits 实现在 `packages/credits/src`，组合业务实现在 `packages/business/src`。两个支付适配器位于各自包的 `src/business.ts`。`pnpm test:sdk` 同时运行 SDK 入口、独立 PayPal、Stripe 业务支付适配器、通用订阅、credits、business 和 Admin 审计测试。完整 SDK 安装包会包含这些独立包。

请用根目录 `pack:sdk` 生成完整安装包；直接打包本目录只包含入口层。其他独立插件仍保留在工作区中，可按需构建和接入。
