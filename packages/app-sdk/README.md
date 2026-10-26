# 认证与支付 SDK

`@app/auth-sdk` 统一导出 Better Auth 服务端、客户端插件、React、Next.js、通用订阅、credits、组合业务、Stripe 和 PayPal 功能，保持各功能包的参数、返回值和类型推导。

内容审核入口 `@app/auth-sdk/moderation` 已实现服务端分层检测、工作流授权、回流、复核、声明及脱敏导出。完整调用合同、宿主适配器与接入限制见 [使用说明](../../docs/moderation-usage.md)；设计目标及生产验收边界见 [设计文档](../../docs/moderation-design.md)。

## 安装

生成能力通过独立 `packages/generation` 提供，统一入口为 `@app/auth-sdk/generation`。包含 OpenAI Images、Google 图片 / 视频、fal Queue、Kie.ai Market、用户隔离任务、幂等提交与断点恢复。接入需宿主调度器、私有存储和数据库迁移；完整配置与安全边界见 [生成插件说明](../generation/README.md)。

0.3.0 新增 SeeAPI 文本 / 图片 / 视频审核和 Kie.ai 图片 / 视频生成，配置及完整联动说明见 [服务商接入](../../docs/seeapi-kie-usage.md)。当前供应商实测未完成，不将 HTTP 测试边界视为生产验收。

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
| `@app/auth-sdk/api-key` | `apiKey`、错误码与 API Key 类型 |
| `@app/auth-sdk/api-key/client` | `apiKeyClient` 密钥管理客户端 |
| `@app/auth-sdk/api-key/types` | API Key 配置与记录类型 |
| `@app/auth-sdk/redis-storage` | `redisStorage` 共享 secondary storage 适配器 |
| `@app/auth-sdk/mcp` | `mcp`、`requireMcpAuth`、`createMcpProtectedRequestHandler` 及配置类型 |
| `@app/auth-sdk/i18n` | `i18n` 认证错误翻译插件、`locales` 与配置类型 |
| `@app/auth-sdk/i18n/client` | `i18nClient` 客户端类型推导 |
| `@app/auth-sdk/i18n/locales` | 22 种内置语言的认证错误词典 |
| `@app/auth-sdk/migrations` | `getMigrations` 原生迁移器，支持独立安装包 |
| `@app/auth-sdk/generation` | `generation`、`createGenerationService`、任务类型与 schema |
| `@app/auth-sdk/generation/client` | `generationClient` 模型、创建、查询、历史与取消接口 |
| `@app/auth-sdk/generation/providers/openai` | `createOpenAIGenerationProvider`、OpenAI 图片参数 schema |
| `@app/auth-sdk/generation/providers/google` | `createGoogleInteractionsGenerationProvider` 新媒体协议、`createGoogleGenerationProvider` 原协议及参数 schema |
| `@app/auth-sdk/generation/providers/fal` | `createFalGenerationProvider`、按模型配置的 fal Queue 适配 |
| `@app/auth-sdk/generation/providers/kie` | `createKieGenerationProvider`、`KieModelAdapter`、Nano Banana 2 / Grok 参数与映射 |
| `@app/auth-sdk/tickets` | `tickets` 工单插件、`SupportTicket` / `TicketEntry` / `TicketStatus` 类型 |
| `@app/auth-sdk/tickets/client` | `ticketsClient` 用户工单与管理员处理接口 |
| `@app/auth-sdk/moderation` | `moderation`、`createModeration`、OpenAI / SeeAPI / 文本规则检测器、SQL 存储、审核类型和 schema |
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
| `@app/auth-sdk/monitor` | `createMonitorOptions`、`startMonitorWorker`；按需安装监控包 |
| `@app/auth-sdk/monitor/client` | `monitorHeaders`；无服务端依赖 |
| `@app/auth-sdk/stripe` | Stripe 服务端插件 |
| `@app/auth-sdk/stripe/client` | `stripeClient` |
| `@app/auth-sdk/paypal` | PayPal 订单、收款确认与 webhook 验签 |
| `@app/auth-sdk/waffo` | 官方 Pancake SDK 和 `createWaffoBusinessProvider`（服务端 Node.js 20+） |

服务端使用 `betterAuth({ database, secret, baseURL, ... })` 配置认证，再将请求交给 `auth.handler(request)`。会话检查必须传当前请求头：`auth.api.getSession({ headers: request.headers })`。

SDK 包本身不启动 HTTP 服务，管理页面由仓库中的 `apps/dashboard` 应用提供。密钥与数据库配置留在使用方服务端，数据库表需要预先迁移。PayPal 入口仅供服务端使用，默认沙箱，支持一次性付款，不含自动续费。

PayPal.cn 全球收单的服务端客户端实现在独立的 `@app/paypal` 包中，由 `@app/auth-sdk/paypal` 转发导出 `createPayPalClient`，随完整 SDK 安装包一起分发。配置 `clientId`、`clientSecret`、`webhookId` 后，可以创建订单（`createOrder`）、查询订单（`getOrder`）、确认收款（`captureOrder`）和验证回调（`verifyWebhook`）；正式环境使用 `environment: "live"`。

## 程序化认证与共享存储

从 SDK 0.2.0 起，完整安装包包含本地 API Key、Redis Storage、MCP 及 MCP 依赖的 OAuth Provider；保持原生配置和类型，不自动启用。已有 i18n 也随该版本交付。无需单独安装这些 Better Auth 公共包。

### API Key

```ts
import { apiKey } from "@app/auth-sdk/api-key";
import { apiKeyClient } from "@app/auth-sdk/api-key/client";

// 服务端：加入已有 betterAuth 的 plugins。
apiKey();
// 浏览器：加入已有 createAuthClient 的 plugins，供已登录用户管理密钥。
apiKeyClient();
```

注册后按完整认证配置生成并执行迁移，会增加 `apikey` 表。后台服务/API 客户端在请求中发送 `x-api-key`，宿主自有业务路由须显式调用 `auth.api.verifyApiKey({ body: { key, permissions } })` 检查有效性及该操作需要的权限；默认不会为任意网站路由自动鉴权。密钥创建、撤销、过期与限流使用原生接口；不要把所有 API Key 当成管理员。`enableSessionForAPIKeys` 等额外能力需要显式配置。

### Redis secondary storage

启用此入口时安装 `pnpm add ioredis`，并由宿主创建连接：

```ts
import { Redis } from "ioredis";
import { redisStorage } from "@app/auth-sdk/redis-storage";

const redis = new Redis(process.env.REDIS_URL!);
// 放入已有 betterAuth 配置。
const secondaryStorage = redisStorage({ client: redis, keyPrefix: "my-site:auth:" });
```

通过 `betterAuth({ secondaryStorage, ...existingOptions })` 接入。多实例应使用相同 Redis 和前缀，不同网站隔离前缀；宿主负责关闭连接和维护 Redis。它支持会话缓存、临时状态和共享计数，限流是否使用它取决于认证的 `rateLimit.storage` 配置；不替代业务 SQL 数据库。SDK 将 `ioredis` 声明为可选 peer，未启用 Redis 的网站不必安装。

### MCP 授权

```ts
import { mcp, requireMcpAuth } from "@app/auth-sdk/mcp";
import { jwt } from "@app/auth-sdk/plugins";

// 加入已有 betterAuth 的 plugins；resource 使用服务端配置的规范 URL。
const plugins = [
  jwt(),
  mcp({ loginPage: "/login", consentPage: "/consent", resource: process.env.MCP_RESOURCE_URL! }),
];
// 宿主在创建 auth 后，用 requireMcpAuth(auth, handler, { resource, requiredScopes })
// 包装实际 MCP 路由，并在工具执行处核对用户与数据权限。
```

MCP 提供 OAuth 授权及受保护资源元数据，校验 Token 的签名、issuer、audience、有效期及配置的 scope；缺失认证返回带 `WWW-Authenticate` 的 401。独立资源服务可用 `createMcpProtectedRequestHandler` 配置 issuer/audience。登录页、同意页、权限声明与 OAuth/JWT 表迁移由宿主完成。动态客户端注册默认关闭，按实际可信客户端接入方式配置。

本包不提供 MCP 工具或协议传输；这些由宿主接入官方 MCP Server SDK。CIMD 不在此次打包范围中。详细原生行为见 `packages/mcp/README.md` 和导出的 TypeScript 类型。

## 认证错误多语言

完整安装包包含本地 `@better-auth/i18n`，无需另外安装；导出原生插件，不自动注册。`pnpm test:sdk` 包含 i18n 行为回归，`pnpm test:packaging` 验证三个入口的运行时与类型，以及中文请求的认证错误响应。服务端在认证配置中加入：

```ts
import { betterAuth } from "@app/auth-sdk/server";
import { i18n } from "@app/auth-sdk/i18n";
import { en, zh } from "@app/auth-sdk/i18n/locales";

export const auth = betterAuth({
  // 保留网站已有 database、secret、baseURL 和认证配置。
  plugins: [
    i18n({
      translations: { en, zh },
      defaultLocale: "en",
      detection: ["cookie", "header"],
    }),
  ],
});
```

上例优先读取 `locale` Cookie，再读取 `Accept-Language`（按权重匹配基础语言，如 `zh-CN` 匹配 `zh`）；未匹配使用 `en`。默认只检测请求头，也可按顺序配置 `session` 或 `callback`，分别使用会话用户的语言字段或自定义 `getLocale(ctx)`；插件不自动创建用户语言字段或设置 Cookie。

认证请求失败后，插件按错误 `code` 查词典，只替换 `message`，保留 HTTP 状态与 `code`，并添加 `originalMessage`。没有对应翻译则保留原错误，不自动逐条回退到英文词典。内置词典覆盖核心认证错误；业务或其他插件错误可在对应语言词典中按错误码补充。

客户端可从 `@app/auth-sdk/i18n/client` 导入 `i18nClient()` 并加入已有 `createAuthClient` 的 `plugins`；该插件只提供类型推导，翻译由服务端完成。前端显示响应中的 `error.message` 即可。i18n 不翻译页面文案、邮件、用户内容，也不改变内容审核策略。

## Google 登录

Google OAuth 已包含在 SDK 中，不需要新插件或额外安装公共版本 `better-auth`。使用原生 `socialProviders.google`、`signIn.social()` 和 `linkSocial()`；邮箱密码、Admin、Business 等现有配置可以继续放在同一个认证实例中。

### Google 控制台与环境变量

1. 在 [Google Auth Platform](https://console.cloud.google.com/auth/overview) 选择网站项目，按控制台填写品牌、支持邮箱和受众；外部应用在测试状态时按要求添加测试用户，上线前完成适用的发布/验证流程。
2. 在 Clients 创建类型为 **Web application** 的 OAuth 客户端。将下面的认证回调登记到 **Authorized redirect URIs**；不是网站首页，也不是登录后的页面。
3. 将客户端 ID 和密钥写入网站服务端环境。密钥不能使用 `NEXT_PUBLIC_` / `VITE_` 前缀，也不能通过组件属性发给浏览器。开发和生产分别登记实际地址；生产使用 HTTPS。

| 场景 | `BETTER_AUTH_URL` | Google Authorized redirect URI |
| --- | --- | --- |
| 自带 Dashboard 开发 | `http://127.0.0.1:3001` | `http://127.0.0.1:3001/api/auth/callback/google` |
| 网站开发示例 | `http://localhost:3000` | `http://localhost:3000/api/auth/callback/google` |
| 网站生产示例 | `https://www.example.com` | `https://www.example.com/api/auth/callback/google` |

协议、域名、端口、路径和末尾斜线需要精确匹配，`localhost` 与 `127.0.0.1` 是不同配置。若更改 `basePath`，表中的 `/api/auth` 也要一起修改。本流程由后端交换授权码；不使用 One Tap 或 Google 浏览器脚本，不依赖 Authorized JavaScript origins 代替回调地址。参见 [Google 创建凭据与回调规则](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred)。

```dotenv
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=<至少 32 字符的独立随机密钥>
DATABASE_URL=<网站自己的 PostgreSQL 连接串>
GOOGLE_CLIENT_ID=<Web application 客户端 ID>
GOOGLE_CLIENT_SECRET=<客户端密钥>
```

### 服务端与认证路由

新网站的最小配置如下。已有网站只将 `socialProviders.google` 合并进现有 `auth`，复用数据库、密钥与 `/api/auth`，避免再建一个认证实例。以下示例要求两项 Google 凭据完整；自带 Dashboard 则允许两项都留空以关闭 Google。

```ts
// lib/auth.ts，仅在服务端导入。
import { betterAuth } from "@app/auth-sdk/server";
import { Pool } from "pg";

const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  throw new Error("Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
}

export const auth = betterAuth({
  database: new Pool({ connectionString: process.env.DATABASE_URL }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  socialProviders: {
    google: { clientId, clientSecret, prompt: "select_account" },
  },
  // 在已有网站中保留原有 emailAndPassword、邮件回调及 plugins。
});
```

Next.js App Router 挂载认证路由：

```ts
// app/api/auth/[...all]/route.ts
import { toNextJsHandler } from "@app/auth-sdk/next-js";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";
export const { GET, POST } = toNextJsHandler(auth);
```

其他框架同样将 `/api/auth/*` 的原生 `Request` 交给 `auth.handler(request)`，完整返回 `Response` 和 `Set-Cookie`。先按完整认证配置迁移数据库，再开放路由；Google 复用现有 user/account/session 表，不额外建立 Google 用户库。网络需能访问 Google 授权、Token 和公钥端点。

### 网站前端

```ts
// lib/auth-client.ts
"use client";
import { createAuthClient } from "@app/auth-sdk/react";

export const authClient = createAuthClient();
```

网站自己的登录按钮可以直接接入。将 `/account` 和 `/login` 替换为网站实际页面；按钮外观可替换成网站已有组件：

```tsx
"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function GoogleLoginButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function signIn() {
    setBusy(true);
    setError("");
    try {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: "/account",
        errorCallbackURL: "/login",
      });
      if (result.error) throw new Error(result.error.message || "Google 登录暂时不可用");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Google 登录暂时不可用");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" disabled={busy} onClick={() => void signIn()}>
        {busy ? "正在跳转…" : "使用 Google 账号登录"}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
```

SDK 默认跳转 Google，成功后通过认证回调设置当前网站会话 Cookie，再返回 `callbackURL`；它与 Google 控制台登记的 `/api/auth/callback/google` 用途不同。按钮等待期间禁止重复提交；失败时显示明确提示。使用网站现有会话接口 `authClient.useSession()` / `getSession()`；服务端校验仍须传当前请求头 `auth.api.getSession({ headers: request.headers })`。按钮使用 [Google 官方品牌素材](https://developers.google.com/identity/branding-guidelines)，自带 Dashboard 的图标来自该页面。

### 账号绑定与注册策略

首次 Google 登录默认创建普通用户；启用 Admin 插件时角色是 `user`，不会获得后台权限。仅需登录已有用户的网站可在 `socialProviders.google` 设置 `disableSignUp: true`；这只限制 Google 新注册，不改变邮箱注册设置。自带 Dashboard 的 Google 登录允许新建普通网站用户，邮箱注册是否开放仍由 SMTP 配置决定。

同邮箱账号不会无条件合并：默认要求已有本地邮箱已验证、Google 邮箱已验证且允许账号关联。初始化管理员的本地邮箱未验证时会返回 `account_not_linked`。此时先通过原有方式登录，再明确绑定：

```ts
const result = await authClient.linkSocial({
  provider: "google",
  callbackURL: "/account",      // 网站已有的账号页面；Dashboard 使用当前后台路径。
  errorCallbackURL: "/account",
});
if (result.error) throw new Error(result.error.message || "Google 绑定未完成");
```

绑定要求有效登录会话，默认 Google 邮箱与当前账号邮箱一致；已绑定到其他用户的 Google 账号不能被接管。自带 Dashboard 已在管理员登录后的顶部提供“绑定 Google 账号”。不要为省去这一步关闭本地邮箱验证、开放不同邮箱绑定或根据 Google 邮箱自动提升管理员角色。

### 常见失败与验收

| 现象或 `?error=` | 检查与恢复 |
| --- | --- |
| `redirect_uri_mismatch` | 核对实际授权 URL 的 `redirect_uri`、Google 控制台登记和 `BETTER_AUTH_URL`；页面放到 `/admin` 不改变认证回调 |
| 未显示 Dashboard Google 按钮 | 检查两项服务端凭据是否都已配置，并重启应用 |
| `access_denied` | 用户取消授权，或 Google 受众/测试用户限制；显示提示后允许重试或邮箱登录 |
| `account_not_linked` | 先用原有方式登录并绑定，或完成已有本地邮箱的验证 |
| `email_does_not_match` | 绑定时选择与当前账号邮箱相同的 Google 账号 |
| `state_mismatch` / `state_not_found` | 从网站重新发起登录；核对访问域名、HTTPS、Cookie 与代理配置，不关闭 state 校验 |
| Google 登录成功但后台拒绝访问 | 检查该用户是否已有管理员角色；Google 身份不等于管理员权限 |

错误页只显示已知错误对应的提示，对未知错误显示统一失败信息；不要将 `error_description` 当作 HTML 或直接显示提供方返回正文。部署后用真实 Google 测试账号验证首次登录、退出后重登、既有账号绑定、取消授权、普通用户后台拒绝访问，并检查会话 Cookie。仓库回归使用隔离数据库及明确的测试响应验证流程，不能替代真实凭据、控制台和网络联调。

## 用户反馈工单

工单是独立可选插件，不要求订阅、积分或支付功能。它使用现有登录会话和同一个网站数据库；需要 `admin({ auditLog: true })`，SQL 适配器必须支持真实事务与唯一索引。内存适配器及只顺序执行的事务替代会在初始化时明确报错。

### 服务端与数据库迁移

在已有 `lib/auth.ts` 的同一个实例中添加插件，保留原有数据库、登录方式、密钥及业务配置：

```ts
import { betterAuth } from "@app/auth-sdk/server";
import { admin } from "@app/auth-sdk/plugins";
import { tickets } from "@app/auth-sdk/tickets";

// 合并到已有 betterAuth 配置；database、secret、baseURL 继续使用网站现有值。
export const auth = betterAuth({
  database,
  secret,
  baseURL,
  plugins: [admin({ auditLog: true }), tickets()],
});
```

不要重复注册 Admin 插件：若已启用，确认原配置包含 `auditLog: true`，仅追加 `tickets()`。沿用 `/api/auth/[...all]` 和 `toNextJsHandler(auth)` 或现有 `auth.handler(request)`；不需要另起工单 HTTP 服务或新增环境变量。

升级时先备份目标数据库，使用完整认证配置审查并执行迁移。例如在网站**显式部署迁移命令**中调用：

```ts
import { getMigrations } from "@app/auth-sdk/migrations";
import { auth } from "./lib/auth";

const { runMigrations } = await getMigrations(auth.options);
await runMigrations();
```

新增 `supportTicket`（所有者、标题、初始内容、状态、revision、创建/更新时间）和 `supportTicketEntry`（回复/状态变化、作者、角色、序号及时间），以及 `(userId, idempotencyKey)`、`(authorId, idempotencyKey)`、`(ticketId, sequence)` 唯一索引。后台沿用 Admin 审计表；已有管理员初始化脚本不能当作升级迁移命令重复运行。请求中不会自动迁移。删除用户保留工单历史及原用户 ID；本版不提供工单或消息删除接口。

### 网站客户端

```ts
import { createAuthClient } from "@app/auth-sdk/react";
import { ticketsClient } from "@app/auth-sdk/tickets/client";

export const authClient = createAuthClient({
  plugins: [ticketsClient()], // 合并进网站已有的 client plugins。
});
```

登录后的用户可以直接调用：

```ts
// 一次明确的新提交生成一个 UUID；网络失败时保留该编号和原载荷重试。
const createKey = crypto.randomUUID();
const created = await authClient.tickets.create({
  title: "无法查看付款记录",
  content: "请协助检查我的账户付款记录。",
  idempotencyKey: createKey,
});
if (created.error) throw new Error(created.error.message || "提交失败");
const ticketId = created.data.ticket.id;

const list = await authClient.tickets.list({ query: { limit: 20, offset: 0 } });
const detail = await authClient.tickets.get({ query: { ticketId, limit: 20, offset: 0 } });
const replyKey = crypto.randomUUID();
const replied = await authClient.tickets.reply({
  ticketId,
  content: "补充：刷新页面后仍然出现。",
  idempotencyKey: replyKey,
});
if (replied.error) throw new Error(replied.error.message || "回复失败");
```

`list` 返回 `{ tickets, total }`；`get` 返回 `{ ticket, entries, total }`，其中 `total` 是追加回复和状态记录的总数，不包含 `ticket.content` 中的首次提交。`entries` 按 `sequence` 升序排列，`kind` 为 `reply` 或 `status`；作者角色由服务端产生。所有列表都支持 `limit`（默认 20、上限 100）和 `offset`（默认 0），工单列表额外支持 `status` 筛选。

标题去除首尾空白后为 1～200 字符，初始内容和回复为 1～10000 字符；空白、NUL、伪造所有者/角色/状态等额外写入字段会被拒绝。用户 ID 来自服务端会话，浏览器不得传入其他用户 ID。内容为**纯文本**，渲染时使用 React 文本节点并保留换行，不使用 `dangerouslySetInnerHTML`。SDK 保留正文中的日期文本，`createdAt` / `updatedAt` 正常解析为 Date；自定义 JSON parser 的行为由宿主负责。

### 管理员处理

管理端复用同一个客户端；权限在每次请求时重新读取，不依赖浏览器角色或旧的 Cookie 缓存：

```ts
const all = await authClient.tickets.admin.list({ query: { status: "open", limit: 20, offset: 0 } });
const detail = await authClient.tickets.admin.get({ query: { ticketId, limit: 20, offset: 0 } });
if (detail.error) throw new Error(detail.error.message || "无法读取工单");

const replyKey = crypto.randomUUID();
const reply = await authClient.tickets.admin.reply({
  ticketId, content: "已收到反馈，我们正在核对。", idempotencyKey: replyKey,
});
if (reply.error) throw new Error(reply.error.message || "回复失败");

// 回复也会增加 revision，改状态前读取最新详情。
const latest = await authClient.tickets.admin.get({ query: { ticketId } });
if (latest.error) throw new Error(latest.error.message || "刷新失败");
const statusKey = crypto.randomUUID();
const changed = await authClient.tickets.admin.status({
  ticketId, status: "in_progress",
  expectedRevision: latest.data.ticket.revision,
  idempotencyKey: statusKey,
});
if (changed.error) throw new Error(changed.error.message || "状态保存失败");
```

状态为 `open`（待处理）、`in_progress`（处理中）和 `closed`（已关闭）。管理员可在三种状态之间切换，包括重新打开已关闭工单；关闭后任何角色都不能新增回复。状态变化和管理员回复的工单记录、revision 及审计在同一事务中提交，任一步失败均回滚。审计只保存工单 ID、动作和序号/状态，不复制反馈正文。

| 客户端调用 | HTTP 路径，位于现有认证 basePath 下 |
| --- | --- |
| `tickets.create()` | `POST /tickets/create` |
| `tickets.list()` / `tickets.get()` | `GET /tickets/list` / `GET /tickets/get` |
| `tickets.reply()` | `POST /tickets/reply` |
| `tickets.admin.list()` / `tickets.admin.get()` | `GET /tickets/admin/list` / `GET /tickets/admin/get` |
| `tickets.admin.reply()` | `POST /tickets/admin/reply` |
| `tickets.admin.status()` | `POST /tickets/admin/status` |

服务端也可使用同名 `auth.api.createSupportTicket`、`listSupportTickets`、`getSupportTicket`、`replySupportTicket`、`listAdminSupportTickets`、`getAdminSupportTicket`、`replyAdminSupportTicket` 和 `updateSupportTicketStatus`，传当前请求的 `headers` 和对应 `body` / `query`；保留当前 Origin，写请求仍执行正常 CSRF 检查。

### 权限、重试与网站界面

匿名请求返回 401；用户读取或回复他人工单返回 404；普通用户管理接口返回 403。管理员沿用 Admin 插件的 `adminRoles`（默认 `admin`）与 `adminUserIds`，禁用账号和模拟登录会话不能访问工单接口。所有工单响应设置 `Cache-Control: no-store`。

每次明确新建、追加回复或修改状态，生成独立的 UUID `idempotencyKey`。未确认写入时必须复用原键及原载荷；重复成功请求返回原记录，不重复回复、改状态或记审计。相同键更换载荷、状态 revision 已过期或并发更新返回 409；先刷新并核对工单，再决定是否生成新的操作键。数据库异常直接报错，不生成成功占位记录。

网站可使用自己的反馈页面调用上述接口，或复制 Dashboard 的 `tickets-panel.tsx`、`ticket-thread.tsx` 及现有共享 UI，接上网站同一 `authClient`。Dashboard 的 `/support` 是用户可用页面，后台“工单”页签使用管理接口；管理员在用户页面同样只看到自己的工单。界面包含新建、分页/状态筛选、初始内容、对话/状态历史、追加回复、关闭和重新打开；加载、空列表、权限错误和冲突都明确展示。用户页面需要已有账号或网站原有注册流程，插件不新建注册入口。本版不含附件、内部备注、邮件提醒、SLA 或第三方客服连接。

## Dashboard 接入

仓库中的 [apps/dashboard](../../apps/dashboard/README.md) 是基于指定模板的 Next.js 管理后台，保留原排版、配色、横向 Tabs、图表和弹窗动效，包含概览、用户与会话、套餐、订单、付款统计、会员、积分、操作记录、监控和工单。它使用 `@app/auth-sdk/react`、`adminClient()`、`businessClient()` 与 `ticketsClient()` 调用真实接口；页面源码不随 `auth-sdk.tgz` 分发。

本地从仓库根目录运行 `pnpm build:sdk`，复制 `apps/dashboard/.env.example` 为 `apps/dashboard/.env.local`，填写密钥、数据库、初始管理员及 `BETTER_AUTH_URL=http://127.0.0.1:3001`，然后执行 `pnpm dashboard:setup` 和 `pnpm dashboard:dev`。初始化命令会迁移表并创建新管理员，访问地址为 `http://127.0.0.1:3001`；具体配置和生产数据库要求见应用说明。

需要 Google 登录时填写 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`，登记对应认证回调并重启；两项留空时不显示 Google 入口。已有管理员首次接入可先用邮箱密码登录，再点击顶部“绑定 Google 账号”，之后从登录页使用 Google。具体步骤见 [Dashboard Google 登录](../../apps/dashboard/README.md#google-登录与账号绑定)。

迁入已有网站时，复用 `apps/dashboard/components` 中的面板，将 `apps/dashboard/lib/auth.ts` 的 `getAuth()` 接到网站现有认证实例，在 `lib/auth-client.ts` 复用同源认证路由，并为该实例启用 `admin({ auditLog: true })`、`tickets()`、`subscription({ catalog: true })`、`credits()` 和 `business({ providers })`。管理员和网站用户共用同一数据库，已有 `/api/auth` 路由无需重复创建。保留网站原有注册策略和服务端权限校验；支付适配器、付款及退款核验仍由网站可信服务端配置。

复用登录界面时还需复制 `apps/dashboard/public/google-g.png` 到网站的 `public/google-g.png`；服务端页面只传 Google 启用标记和安全错误提示，不传凭据。

## 可信业务监控

监控复用 Business 插件的真实注册与可信付款流程。启用网站安装固定版本的 `monitor-analytics-sdk-0.1.1.tgz`，与 `auth-sdk.tgz` 一同复制到网站 `vendor/`；禁止使用开发机器绝对路径作为运行依赖。监控包仅在导入服务端监控入口时需要。该入口与监控发送产物使用 ES2022 和 Web API，Collector 与本仓库工具使用 Node 24。

```ts
import { business } from "@app/auth-sdk/business";
import { createMonitorOptions, startMonitorWorker } from "@app/auth-sdk/monitor";

// 在原有 auth 实例的 plugins 中替换已有 business 配置：
business({ providers, monitor: createMonitorOptions({ env: process.env }) });
// 保留 admin({ auditLog: true })、subscription({ catalog: true }) 和 credits()。

// 每个常驻服务实例启动一次；Dashboard instrumentation 已完成此步骤。
const worker = startMonitorWorker({ auth });
// 关闭宿主服务时，先停止 worker，再关闭数据库：
await worker.stop();
```

`createMonitorOptions()` 在 Node 默认读取 `process.env`；Workers/Deno 可显式传入 `env`。`APP_MONITOR_ENABLED` 缺省或 `false` 返回 `undefined`，启用时配置不完整会在初始化时抛错。轮换配置后重启。Worker 立即处理一次，随后每 60 秒处理，单轮最多 20 条、并发 2；不会重叠运行。多实例通过数据库条件更新租约协调，进程中断后回收到期租约。无常驻进程的宿主由已有调度调用 `auth.api.runMonitorDelivery()`，不能依赖请求结束后的定时器。

| 服务端变量 | 规则 |
| --- | --- |
| `APP_MONITOR_ENABLED` | `true` 启用；默认关闭 |
| `APP_MONITOR_SITE_ID` | 1–64 位字母、数字、`_`、`.`、`-`，首位须为字母或数字 |
| `APP_MONITOR_ENDPOINT` | Collector 完整 HTTPS `/v1/server-events` 地址；禁止用户信息、查询参数和片段；仅 development 允许回环 HTTP |
| `APP_MONITOR_TOKEN` | 32–256 位无空白 ASCII 写入凭证，只在服务端保存，不使用 `NEXT_PUBLIC_` |
| `APP_MONITOR_ENVIRONMENT` | `production`、`staging`、`development`；默认按 `NODE_ENV` 选择生产或开发 |
| `APP_MONITOR_ORIGINS_JSON` | 必填，本站精确 HTTP(S) origin 的非空 JSON 数组，与 Collector 配置一致 |
| `APP_MONITOR_ALLOWED_PATHS_JSON` | 公共路径 JSON 数组，默认 `[]`；根路径与 `/[redacted]` 按协议始终允许 |
| `APP_MONITOR_RETRY_WINDOW_DAYS` | 正整数，默认首次尝试后 7 天 |
| `APP_MONITOR_COLLECTOR_RETENTION_DAYS` | 正整数，默认 30，必须填写 Collector 实际保留期，且严格大于补发窗口 |

Collector 该站点写入凭证须允许 `signup_confirmed: ["method"]`、`payment_confirmed: ["amount", "currency"]`，来源和公共路径白名单保持一致。一个网站使用独立数据库、站点 ID 和凭证。站点 ID 变更不会搬迁旧站点记录。

浏览器沿用已初始化且按许可返回归因的监控实例：

```ts
import { monitor } from "monitor-analytics-sdk";
import { monitorHeaders } from "@app/auth-sdk/monitor/client";

await authClient.signUp.email({
  name, email, password,
  fetchOptions: { headers: monitorHeaders(monitor.getAttributionContext()) },
});
// 仅在网站原本已启用该 OAuth 渠道时使用：
await authClient.signIn.social({
  provider: "google", callbackURL: "/",
  fetchOptions: { headers: monitorHeaders(monitor.getAttributionContext()) },
});
await authClient.business.orders.create({
  productId, provider, idempotencyKey,
  fetchOptions: { headers: monitorHeaders(monitor.getAttributionContext()) },
});
```

请求头 `X-Monitor-Context` 为 base64url JSON，编码后最多 4 KiB。缺失、无效、超限数据直接省略，服务端再次校验站点、结构、URL、来源与公共路径。未获得归因许可时 `getAttributionContext()` 返回缺失值，不生成替代访问来源。跨域网站需在既有认证/CORS 配置允许此头。用户、订单、金额和事件 UUID 均由后端确定；浏览器归因只用于分析，不可用于身份或支付授权。

邮箱注册在真实用户 insert 前保存不可由客户端写入/会话读取的内部快照与待入队标记，后台将已提交用户物化为投递记录并在同一事务清除标记。邮箱验证、登录、重复注册的通用成功响应、管理员建号与初始化均不新增事件。OAuth 使用现有受保护的 `serverContext` 携带线索，只实际新建账号时计数，不更改 OAuth state 或启用新渠道。

订单独立保存首次创建时的归因，同一幂等键重试不覆盖；没有当前线索时不继承用户注册来源。付款事件与可信付款在同一数据库事务入队，履约失败仍可投递。重复通知、主动查询和履约重试按“站点＋渠道＋实际付款 ID”去重。已有真实续费确认入口生成新订单并继承原订单归因。本版不新增退款监控或来源转化报表。

| `auth.api` 方法 | 认证 base path 下 HTTP 路径 | 权限 |
| --- | --- | --- |
| `getMonitorStatus({ headers })` | `GET /business/admin/monitor/status` | `monitor:read` |
| `listMonitorEvents({ headers, query })` | `GET /business/admin/monitor/events` | `monitor:read` |
| `getMonitorAttribution({ headers, query })` | `GET /business/admin/monitor/attribution` | `monitor:read` |
| `retryMonitorEvent({ headers, body })` | `POST /business/admin/monitor/retry` | `monitor:retry` |
| `runMonitorDelivery()` | 无 HTTP 路由 | 仅服务端 |

列表 `query` 支持 `limit`（默认 20、上限 100）、`offset`、`type`（`signup_confirmed` / `payment_confirmed`）、`status`（`pending` / `processing` / `sent` / `failed` / `expired`）、`userId`、`orderId`。归因查询必须且只能传 `userId` 或 `orderId`。查询站点固定为服务端配置，不接受客户端站点选择。客户端使用 `authClient.business.admin.monitor.status/events/attribution/retry`。权限复用 `BusinessOptions.authorize`，默认管理员可操作；匿名、禁用用户、模拟登录会话均不能访问。

补发 `body` 为 `{ eventId, operationId, reason }`，复用现有审计和幂等操作记录。失败记录在窗口内才能补发，成功记录不可补发。事件 ID、原业务时间和载荷始终不变，不重新核验付款或发放权益。关闭监控后保留数据，所有采集/投递暂停；首次启用不扫描补报历史用户或历史付款。

发送函数限制 5 秒，只接受有效 `{accepted, duplicates}` 回执。网络、429、5xx 指数退避（遵守 Retry-After），最多自动尝试 8 次。协议、配置或权限错误进入 `failed`；手动补发保留累计尝试次数，已达 8 次的事件只执行本次人工安排。超过首次尝试后的窗口停止投递。策略变化导致旧快照不再合法时标记失败，不能静默删改旧快照。记录和日志只保存安全错误码及 HTTP 状态，不保存响应正文、凭证或网络错误原文。

升级先迁移完整 auth schema：`user` 新增 `monitorSignup`（JSON）、`monitorSiteId`、`monitorSignupPending`（默认 false）；`businessOrder` 新增 `monitorContext`（JSON）；新增 `businessMonitorEvent`、UUID/业务键唯一约束和租约查询索引。即使关闭监控，这些 schema 也保留。使用既有迁移流程或 `getMigrations(auth.options).runMigrations()`；不要在请求中自动迁移。JSON 快照内的 ISO 时间保留字符串，普通用户和订单响应不返回内部字段。生产需要支持真实事务和唯一索引的 SQL 适配器。

## 用户付款统计

付款统计已集成在现有 `business()` / `businessClient()` 中，沿用网站同一个认证实例、数据库和 `/api/auth` 路由，无需额外插件、密钥或统计服务。原有 `getBusinessOverview` 保持不变；下面的新接口提供详细收入与消费数据，站点统计 handler 的付款数据由网站可选提供 `countPaidUsers`，未接入时返回 `null`。

### 网站查询示例

在已有客户端保留 `businessClient()`；其服务端仍须启用 `admin({ auditLog: true })`、`subscription({ catalog: true })`、`credits()` 和 `business({ providers })`。独立接入初始化方法见 [组合业务启用与迁移](#启用与迁移)。`BusinessPaymentStatistics`、`BusinessCustomerSpending` 与 `PaymentTotals` 类型由 `@app/auth-sdk/business` 导出。

```ts
// 管理后台：UTC 起始时刻包含，结束时刻不包含，单次最多 366 天。
const report = await authClient.business.admin.paymentStats({
  query: {
    from: "2026-10-01T00:00:00Z",
    to: "2026-11-01T00:00:00Z",
    interval: "day", // "month" 按 UTC 自然月分桶；默认 "day"。
  },
});
if (report.error) throw new Error(report.error.message || "无法读取付款统计");
for (const currency of report.data.currencies) {
  // 按币种分别呈现；禁止把 USD、JPY 等金额相加。
  console.log(currency.currency, currency.grossAmount, currency.netAmount);
  console.log(currency.averageOrderAmount, currency.trend);
}
console.log(report.data.conversion); // 注册人数、转化人数和 0～1 的比率。

// 普通网站用户：服务端从当前会话确定用户，不接受 referenceId。
const own = await authClient.business.spending();
if (own.error) throw new Error(own.error.message || "无法读取累计消费");
console.log(own.data.paidOrders, own.data.currencies);

// 管理员：读取指定用户的终身累计消费，与期间筛选无关。
const customer = await authClient.business.admin.spending({
  query: { referenceId: userId },
});
if (customer.error) throw new Error(customer.error.message || "无法读取用户消费");
```

| 服务端方法 | 浏览器调用 / HTTP 路径（认证 base path 下） | 权限 |
| --- | --- | --- |
| `auth.api.getBusinessPaymentStatistics({ headers, query })` | `business.admin.paymentStats()` / GET `/business/admin/payment-stats` | `metrics:read` |
| `auth.api.getBusinessCustomerSpending({ headers, query: { referenceId } })` | `business.admin.spending()` / GET `/business/admin/spending` | `customers:read` |
| `auth.api.getOwnBusinessSpending({ headers })` | `business.spending()` / GET `/business/spending` | 当前登录用户自身 |

服务端调用传入当前请求的真实 `headers`。管理接口每次重新读取会话，沿用 Admin 角色/白名单或 `business({ authorize })` 的细分权限，拒绝普通用户、已封禁账号和模拟管理员会话。自身查询不接受其他用户 ID；未登录返回 401，越权管理返回 403，不存在的目标用户返回 404。响应不允许 HTTP 缓存，不在浏览器保存管理凭据。

### 指标与退款口径

仅统计状态为 `paid`、`fulfilled`、`partially_refunded` 或 `refunded`，同时具有非空付款 ID、有效付款时间和正金额的本地订单。未来付款不计入；履约失败但收款已核验的订单仍计入，反复核验同一付款不会增加订单数。外部历史订单不会自动导入。

| 字段 | 定义 |
| --- | --- |
| `paidOrders` / `paidUsers` | 所选付款区间内的订单数 / 按用户 ID 去重的人数；跨币种总人数也去重，不能简单累加各币种人数 |
| `currencies[].grossAmount` | 该币种所选付款订单的原始已核验收款金额合计 |
| `refundedAmount` | 这些订单**当前已核验并保存**的退款金额合计，包括后来发生的退款 |
| `netAmount` | 收款总额减上述退款；未扣支付手续费、业务成本或另计税费，不是利润 |
| `averageOrderAmount` | 收款总额 / 付款订单数，四舍五入到最小货币单位；无付款时为 `null` |
| `trend[]` | 每个 UTC 日/月的同组指标，按 `periodStart` 升序，无付款桶补零；仅统计请求区间内的付款，首尾桶可能不足完整日/月 |
| `conversion.registeredUsers` | 在 `[from, to)` 注册且查询时仍存在的账户数，含所有角色 |
| `conversion.convertedUsers` | 上述注册用户中，在同一区间内至少成功付款一次的去重人数，跨币种去重，之后退款仍算完成过付款 |
| `conversion.rate` | 转化人数 / 注册人数，0～1；没有注册用户时为 `null`，不是访问者转化率或所有历史用户付费率 |

金额使用各币种 ISO 最小单位及安全整数，不能统一除以 100：例如 JPY 没有小数位。网站可复用 Dashboard `lib/format.ts` 的 `money` 及币种小数位规则；图表的近似轴标签不能代替表格精确金额。默认客户端会将日期字段解析为 `Date`；HTTP 原始 JSON 中为 ISO 字符串。

这是一份**按付款批次重述的报表**：例如一月付款、二月退款，刷新一月报表时退款会扣回一月净额，不生成二月退款现金流。当前 Stripe、PayPal、Waffo 业务适配器尚未提供自动退款同步；只有通过已接入的可信 `verifyRefund` 与 `confirmBusinessRefund` 核对并保存的退款才会扣减，不能把未同步的渠道退款当作 0 元退款的证明。Waffo 收款为已核验的税前商品金额，不含代收税额。

用户累计消费返回 `{ referenceId, generatedAt, paidOrders, firstPaidAt, lastPaidAt, currencies }`，按其全部已核验订单汇总，币种分开。没有付款时日期为 `null`、订单数为 0、币种列表为空。已删除用户的历史订单仍可参与收入/付费人数统计，但不参与当前注册账户转化率，管理端也不能按不存在的账户查询详情。

### Dashboard、升级与限制

“付款统计”默认查询 UTC 本月至今天，可选择开始/结束日期、日/月粒度和展示币种。结束日期含当天，客户端转换为次日 UTC 零点的排他上界。收入汇总显示全部币种，图表每次展示一种币种，并提供可分页的数据表。无付款、无注册用户、非法日期及服务失败分别展示，不用 0 掩盖错误。用户页的“账户详情 → 累计消费”独立刷新，不受统计期间影响。

升级前备份数据库，使用 [完整认证迁移配置](#服务端与数据库迁移) 执行 `getMigrations(auth.options)` / `runMigrations()`，增加 `businessOrder.paidAt` 索引；无需新增统计表或回填虚构收款，也不要重跑管理员初始化脚本。已有本地核验订单可直接统计。

查询从真实数据库按 ID 分页，每页 500 笔、只读取汇总所需列；单次最多 100000 笔符合条件的付款，超过返回 503 而非截断结果。期间报表可缩短日期范围；单用户终身消费超过此规模时需要宿主接入数据库原生聚合。金额合计超出安全整数、退款大于收款或数据库异常会明确失败，不返回近似成功结果。报表反映查询时已入库状态，查询过程中发生的新收款/退款可能需要刷新后反映，不提供会计结算快照或汇率换算。

## SEO-worker 站点统计

`createMetricsHandler` 返回原生 `(request: Request) => Promise<Response>` 处理函数，由网站挂载一个服务端路由，例如 `/internal/metrics`。接口只接受 GET 请求，通过 `Authorization: Bearer <凭证>` 鉴权，不使用登录 Cookie。无参数仍返回原有快照；`view=registrations` 提供注册趋势，`view=users` 使用单独凭证提供最小邮箱明细。所有响应设置 `Cache-Control: no-store` 和 `Vary: Authorization`；仅无参数快照有短期内部缓存，邮箱明细不缓存。不引入管理员插件或任何写权限。

第一期按独立网站数据库统计。`siteId` 是输出标签，不是租户查询条件；多个网站共用用户库时不能用不同 `siteId` 获取各站用户数，须先提供有明确站点归属过滤的统计实现。

### 环境变量与挂载

| 网站服务端环境变量 | 规则 |
| --- | --- |
| `APP_METRICS_ENABLED` | 只有精确字符串 `true` 启用；默认关闭，处理函数返回 404 |
| `APP_METRICS_SITE_ID` | 启用时必填，1～128 个英文字母、数字、`_` 或 `-` |
| `APP_METRICS_TOKEN` | 启用时必填，32～256 个英文字母、数字、`_` 或 `-`；独立、密码学安全随机生成的服务凭证 |
| `APP_METRICS_USERS_TOKEN` | 可选，明细专用独立凭证，格式同上且必须与聚合凭证不同；省略时禁止邮箱明细 |
| `APP_METRICS_RATE_LIMIT_PER_MINUTE` | 可选，1～60 的整数，默认 6；限制每分钟已授权请求数，缓存命中也计数 |

凭证仅保存于网站和 SEO-worker 服务端，不使用 `NEXT_PUBLIC_` 等会暴露给浏览器的环境变量，不复用 `BETTER_AUTH_SECRET`。可以通过 `crypto.getRandomValues(new Uint8Array(32))` 生成 32 字节随机数，再编码成 64 位十六进制字符串。只满足长度限制的人工密码不等于随机凭证。轮换时更新网站和 SEO-worker 两侧配置并重新创建处理函数。

启用后无效配置会在初始化时抛错；`countPaidUsers` 可省略，旧快照的 `paidUsersThisMonth` 此时返回 `null`，不会把未接付款当成零。关闭时不会运行统计查询。SDK 显式接收 `env`，不自行读取进程环境；Node.js 可传 `process.env`，Cloudflare Workers 可传服务端环境绑定，并可通过 `rateLimitStorage` 使用共享原子限流。

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
| `paidUsersThisMonth` | UTC 当月月初至本次统计时间 `[from, to)` 内已成功付款的去重用户数，由应用付款查询回调提供；未提供回调为 `null` |

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

### 注册趋势与邮箱明细（schemaVersion 2）

聚合请求：`GET /internal/metrics?view=registrations&from=2026-10-01&to=2026-10-08`，使用 `APP_METRICS_TOKEN`。`from/to` 必须是有效 `YYYY-MM-DD`，UTC 半开区间 `[from,to)`，长度 1～366 天；`from` 不得晚于 UTC 今天，`to` 最多 UTC 明天。缺失、未知、重复的参数均返回 400。

```json
{
  "schemaVersion": 2,
  "siteId": "my_site",
  "timezone": "UTC",
  "generatedAt": "2026-10-07T12:00:00.000Z",
  "period": { "from": "2026-10-01", "to": "2026-10-03" },
  "basis": "current_accounts",
  "totalUsers": 20,
  "registeredUsers": 2,
  "verifiedUsers": 1,
  "unverifiedUsers": 1,
  "daily": [
    { "date": "2026-10-01", "registrations": 2, "verifiedUsers": 1 },
    { "date": "2026-10-02", "registrations": 0, "verifiedUsers": 0 }
  ]
}
```

`totalUsers` 是当前用户库总数；其余人数仅统计区间内当前仍存在的认证用户，按用户而非登录账号计数。`verifiedUsers` 表示这些用户目前邮箱已验证，`unverifiedUsers=registeredUsers-verifiedUsers`。`daily` 连续覆盖所有日期（零值保留）；当日仅查询到本次 `generatedAt` 前，期间结束日期仍按请求返回。不会保存已删除账号的历史注册量，也没有访客分母，不能解释为访客注册率或历史新增流水。

明细请求：`GET /internal/metrics?view=users&from=2026-10-01&to=2026-10-08&page=1&q=example`，**只接受 `APP_METRICS_USERS_TOKEN`**。聚合凭证访问明细返回 403，明细凭证访问聚合/旧快照同样返回 403；省略明细凭证时聚合凭证也不能读取邮箱。`page` 可省略（默认 1），须为 1～999999 的整数，`pageSize` 固定 20 不接受覆盖；`q` 可省略，去除首尾空白后最多 200 字符，按邮箱或昵称做不区分大小写的字面子串搜索。结果按 `createdAt` 降序、`id` 升序稳定排序，超出总页数返回空 `items`。

```json
{
  "schemaVersion": 2,
  "siteId": "my_site",
  "generatedAt": "2026-10-07T12:00:00.000Z",
  "period": { "from": "2026-10-01", "to": "2026-10-08" },
  "total": 1,
  "page": 1,
  "pageSize": 20,
  "items": [{ "id": "user_a", "name": "Player", "email": "player@example.com", "emailVerified": true, "createdAt": "2026-10-02T00:00:00.000Z" }]
}
```

新查询复用认证 adapter，尊重 `user.modelName` 和字段映射（例如 `player_user`）。聚合仅投影 `id/createdAt/emailVerified`；明细仅投影并返回上述五个字段，不输出生日、密码、会话或 token。按 ID keyset 每批最多 500 条，单次区间最多扫描 10,000 个现存用户，超限明确返回 503，不截断为成功。两类查询不复用内部缓存。扫描前后校核区间计数，聚合还校核总人数；发现可检测的增删不一致返回 503。此检查不提供事务快照，不能检测所有等量替换或验证状态并发变化；需要严格一致性时应扩展数据库聚合/快照能力。

同一入口还导出 `parseMetricsQuery(url, now)`、`collectRegistrationMetrics(adapter, query, siteId, signal)` 和 `MetricsQuery`，供网站受保护后台复用相同的校验、统计和字段投影。这些是**仅可信服务端**的底层服务，不自带 HTTP 鉴权/限流：调用方必须先完成身份认证与操作授权，使用解析器验证参数、排除 `view:"snapshot"`，并传入有超时的 `AbortSignal`。本地后台无需开启外部 metrics 或伪造 Bearer；HTTP 对外接口必须使用 `createMetricsHandler`，不能直接暴露底层函数。底层服务失败会抛错，调用方不得吞错或伪造零值。

### 限流与服务保护

- 每个处理函数有鉴权前的固定限流：每分钟最多 60 次尝试，错误凭证也计入；通过鉴权后还受默认每分钟 6 次的限制。限额按整个站点处理函数计算，不依据客户端传入的 IP 创建桶。
- 超限返回 429 和 `Retry-After`。仅保留一份 60 秒统计快照，跨 UTC 月份不复用上月快照；每实例只允许执行一批统计查询，忙碌时返回 503，避免并发请求放大数据库负载。
- 统计响应最多等待 5 秒。查询失败或超时统一返回 503，退避 60 秒，不返回底层错误或伪造的零值。底层查询尚未结束时继续保留并发锁，防止超时后立即启动新批次；**响应超时不保证数据库查询取消**，数据库语句超时和有限连接池仍须由接入应用配置。
- 多实例或无服务器部署不能依赖进程内计数实现全站限流。传入 `rateLimitStorage`，使用现有 `BetterAuthRateLimitStorage` 契约的原子 `consume(key, { window, max })` 实现，或在入口网关统一限流。共享存储在每次已授权请求读取缓存或查库之前执行，存储故障返回 503；不能用非原子的读取再写入代替。共享存储不会合并各实例的缓存或并发锁。

公网部署还需在接入网关限制该路由的连接数和请求速率，防止流量在抵达 SDK 前就耗尽服务资源。不同网站使用独立站点 ID、凭证和处理函数，统计凭证不授予任何写入权限。

### SEO-worker 调用约定

SEO-worker 保存 `siteId → HTTPS 接口 URL、服务凭证` 的服务端配置，使用已登记地址发送 `Authorization: Bearer <凭证>`，不从浏览器接受任意目标 URL 或向浏览器返回凭证。建议每 1～5 分钟采集一次或按需刷新；遇到 429/503 遵循 `Retry-After` 退避，保留最后成功结果及其 `generatedAt` 并标明暂时不可用，不把请求失败显示成用户数为零。

SDK 不会自动注册到 SEO-worker、推送数据或创建采集定时任务。SEO-worker 登记该网站的地址和聚合凭证；需要邮箱明细时另外登记专用明细凭证，并在消费端限制可读取邮箱的角色，不把两种凭证返回浏览器。

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

```ts
// 或使用 Waffo。官方 @waffo/pancake-ts 0.26.0 随依赖安装，无需自行实现签名。
import { WaffoPancake, TaxCategory, createWaffoBusinessProvider } from "@app/auth-sdk/waffo";

const waffo = createWaffoBusinessProvider({
  client: new WaffoPancake({
    merchantId: process.env.WAFFO_MERCHANT_ID!,
    privateKey: process.env.WAFFO_PRIVATE_KEY!,
  }),
  storeId: process.env.WAFFO_STORE_ID!,
  productId: process.env.WAFFO_PRODUCT_ID!,
  environment: "test", // 上线用 prod，并更换为正式环境的商户 API Key 私钥
  taxCategory: TaxCategory.SaaS,
  returnURL: `${process.env.APP_ORIGIN!}/payment/return`, // 必须 HTTPS
});
export const paymentProviders = { waffo };
```

也可在同一个 `providers` 对象注册多个适配器，由前端从 `business.providers()` 返回列表选择；Dashboard 示例通过 `PAYMENT_PROVIDER` 一次启用一个。

这三个适配器销售一次性商品：积分、指定天数会员或组合套餐；会员商品不等于自动续费订阅。Stripe 在创建 checkout 时要求订单至少剩余 30 分钟，建议 `orderTtlMs: 60 * 60_000`，剩余不足时应创建新购买操作。PayPal 在捕获前回查归属和金额，并使用原订单期限及稳定幂等键；已完成付款允许过期后对账。PayPal 按支持币种转换最小单位，HUF/TWD 要求整单位价格。现成适配器未实现 `verifyRefund`，退款核对需另接可信退款查询；不提供发起退款接口。

Waffo 需要指定已有的活跃一次性商品，适配器核对它属于指定店铺，避免误用自动扣款商品。商品 ID 在服务端配置；本地目录可共用一个 Waffo 商品，价格由已保存订单通过 `priceSnapshot` 指定。上线前需完成 Waffo 商户审核、发布正式商品并配置对应环境的 webhook。测试和生产使用不同 API Key 私钥；不要将私钥下发浏览器。

Waffo 当前 SDK 使用**税前显示金额字符串**，已移除 `taxIncluded`。适配器将目录最小单位转换成显示金额，Pancake 结账计算税费。核验成功付款的商品金额、税额和总额；Business 订单、统计与监控保存税前商品金额，不含 Waffo 代收税额。支持 USD/EUR/GBP/HKD/CNY（两位小数）及 JPY（整数），其他币种明确拒绝。结账窗口限剩余 1 分钟至 24 小时，复用 `order.id` 作为官方幂等键。

Waffo 的 `providerOrderId` 保存 checkout session ID；实际付款通过 `orderMerchantExternalId=order.id` 查询，核对店铺、环境、一次性商品、完成状态和唯一成功付款。不要将 webhook 的 `ORD_...` 当作 checkout session ID。宿主先调用 `waffo.verifyWebhook(request)` 读取原始请求体验签，得到 `{ orderId }` 后加载本地订单，确认其渠道为 `waffo`、checkout 已持久化，再用保存的 `providerOrderId` 调用 `auth.api.confirmBusinessPayment()`。业务付款 ID 在事务中去重，处理失败应返回非 2xx，让渠道重试；不要在持久化前确认成功。完整实现见 `apps/dashboard/app/api/payments/webhook/route.ts`。

Waffo 结账链接用 `<a target="_blank" rel="noopener noreferrer">` 或用户点击时 `window.open(url, "_blank", "noopener,noreferrer")` 打开。没有取消回调；成功后用户点击 Done 才返回站点，权益以服务端核验为准。官方底层商品、订阅和 webhook API 从同一入口原样导出；Business 适配器不自动同步订阅生命周期或退款。

接口来源：[完整官方文档](https://docs.waffo.ai/llms-full.txt)、[Pancake skill](https://docs.waffo.ai/integrate/skill)、[官方 SDK 源码与变更记录](https://github.com/waffo-com/waffo-pancake-sdk-ts)。skill 的旧示例包含已移除的 `productType`、`taxIncluded` 和数字金额，本集成遵循当前 SDK 类型；Waffo 入口要求 Node.js 20+，不承诺 Cloudflare Workers 兼容。

目录金额按 ISO 4217 最小单位存储，不能使用浏览器地区习惯的四舍五入位数解释价格。Stripe 适配器处理 ISK/UGX 和 MGA 的渠道单位差异，拒绝非整单位 MGA 及尚未支持的三/四位小数币种。已有 HUF、MGA 等商品若曾通过旧版面板录入，应在启用收款前核对价格；此修改不会重写历史订单金额。

如果需要其他已有渠道，可实现下述契约：

| 方法 | 应用必须完成的工作 |
| --- | --- |
| `createCheckout(order)` | 从已保存订单读取用户、金额、币种和商品；复用 `order.id` 作为渠道幂等键；返回稳定 `providerOrderId` 与 HTTPS `url`。不从浏览器接受价格或支付 URL |
| `verifyPayment({ order, reference })` | 根据可信渠道记录查询已完成付款，验证其确属当前商户、用户和本地订单/渠道订单映射；返回 `paymentId`、`providerOrderId`、整数 `amount`、`currency`、`paidAt: Date`，周期付款还返回成对的绝对 `periodStart/periodEnd` |
| `verifyRefund({ order, reference })`（可选） | 核验一笔已经完成、属于该订单付款的退款，返回 `refundId`、`paymentId`、整数 `amount`、`currency`、`refundedAt: Date`；不负责发起退款 |

渠道通知入口必须校验签名，并结合渠道回查核对商户、订单归属、用户、金额、币种和实际收款状态。`reference` 只是供服务端检索的渠道交易/通知标识，不是“已经付款”的证明；不得把浏览器返回参数或未验签 webhook 原样变成 `VerifiedPayment`。业务插件会进一步比对已存 `providerOrderId`、金额、币种、付款 ID 和时间，但无法替适配器证明外部交易真实性。

现成适配器已复用 PayPal Orders、Stripe Checkout 和 Waffo Pancake；原 Stripe 订阅生命周期和 Billing Portal API 保持不变。Webhook 路由由宿主应用挂载，Dashboard 提供 `/api/payments/webhook`，先验签再回查付款，不依赖用户一定返回成功页面。

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

PayPal 实现和测试分别位于 `packages/paypal/src/index.ts`、`packages/paypal/test/paypal.test.ts`；通用订阅实现在 `packages/subscription/src`，credits 实现在 `packages/credits/src`，组合业务实现在 `packages/business/src`。三个支付适配器位于各自包的 `src/business.ts`，Waffo 位于 `packages/waffo`。`pnpm test:sdk` 同时运行 SDK 入口、独立 PayPal、Waffo、Stripe 业务支付适配器、通用订阅、credits、business 和 Admin 审计测试。完整 SDK 安装包会包含这些独立包。

请用根目录 `pack:sdk` 生成完整安装包；直接打包本目录只包含入口层。其他独立插件仍保留在工作区中，可按需构建和接入。
