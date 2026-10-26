# 通用生成插件

`@app/generation` 位于 `packages/generation`，与 `i18n`、`paypal` 同级。主安装包统一导出 `@app/auth-sdk/generation`、`/generation/client` 和 `/generation/providers/{openai,google,fal,kie}`。插件不启动 HTTP 服务、后台定时器或外部队列。

SDK 0.3.0 新增 Kie.ai Market 图片 / 视频适配，采用显式模型映射和任务轮询；提供 Nano Banana 2 文生图 / 参考图生图，以及 Grok 文生视频 / 单图生视频的保守参数与映射。连接 SeeAPI 审核的完整步骤、素材引用转换、CDN 白名单和未验收边界见 [服务商接入](../../docs/seeapi-kie-usage.md)。

首期支持文生图、参考图生图、文生视频、单图生视频。内置 OpenAI Images、Google Interactions 图片 / 视频、Google generateContent 图片 / Veo predictLongRunning 视频、fal Queue 适配器；其他生成器实现 `GenerationProvider` 即可接入。每个模型必须注册真实支持的操作、输入数量和参数 schema；注册一个平台不会自动开放平台全部模型。

## 服务端接入

先在仓库根目录执行 `pnpm pack:sdk`，在网站安装产物。以下 `privateGenerationAssets` 是网站实际提供的私有存储适配器，合同见下节；环境变量由宿主读取，SDK 不自动加载 `.env`。

```ts
import { betterAuth } from "@app/auth-sdk/server";
import { generation } from "@app/auth-sdk/generation";
import {
  createOpenAIGenerationProvider,
  openAIImageParameters,
} from "@app/auth-sdk/generation/providers/openai";
import {
  createGoogleInteractionsGenerationProvider,
  googleInteractionVideoParameters,
} from "@app/auth-sdk/generation/providers/google";
import { privateGenerationAssets } from "./generation-assets";

export const auth = betterAuth({
  database, // 网站现有数据库，需支持真实事务与唯一索引
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  plugins: [
    generation({
      providers: [
        createOpenAIGenerationProvider({ apiKey: process.env.GENERATION_OPENAI_API_KEY! }),
        createGoogleInteractionsGenerationProvider({ apiKey: process.env.GENERATION_GOOGLE_API_KEY! }),
      ],
      models: [
        {
          id: "product-image", providerId: "openai",
          model: process.env.GENERATION_OPENAI_IMAGE_MODEL!, version: "1",
          kind: "image", modes: ["text-to-image", "image-to-image"],
          maxInputAssets: 2, parameters: openAIImageParameters,
        },
        {
          id: "short-video", providerId: "google-interactions",
          model: process.env.GENERATION_GOOGLE_VIDEO_MODEL!, version: "1",
          kind: "video", modes: ["text-to-video", "image-to-video"],
          maxInputAssets: 1, parameters: googleInteractionVideoParameters,
        },
      ],
      assets: privateGenerationAssets,
    }),
  ],
});
```

模型 ID 从供应商账号当前可调用清单选取，不提供可能过期的默认模型。新 Google 接入优先选 `createGoogleInteractionsGenerationProvider`，图片参数使用 `googleInteractionImageParameters`，视频参数使用 `googleInteractionVideoParameters`。该适配器使用 `background=true` 与 `store=true`，通过真实 Interaction ID 轮询或取消；Google 会按账号保留策略保存请求，参见 [后台执行与数据保留](https://ai.google.dev/gemini-api/docs/interactions-overview#data-storage-and-retention)。视频请求 URI 交付以避免将大视频内联进 API JSON。

`createGoogleGenerationProvider` 保留 generateContent / predictLongRunning 协议，分别配合 `googleImageParameters` / `googleVideoParameters`。Google 官方当前注明 Gemini API 的 Veo 3.1 Preview 将在 **2026-10-22** 关闭，不能给新网站配置这些即将停用的模型；当前状态见 [官方视频说明](https://ai.google.dev/gemini-api/docs/video)。

上面的通用 schema 还需按所选型号收窄尺寸、比例、数量、时长等取值；用 `schema.extend(...)` 配置具体枚举和上限。改变注册定义时递增 `version`；已有任务使用创建时的模型、参数快照。

服务端凭据只放宿主 `.env` / 密钥管理中，参考本目录 `.env.example`。`id` 标识供应商连接；不要在未完成旧任务时将同一个供应商 ID 切换至另一账号、环境或 API 地址。移除模型可停止新提交，但需保留旧任务使用的供应商配置。

用完整 `auth.options` 执行 `getMigrations`，新增 `generationJob`、`generationAttempt`、`generationAsset`、`generationEvent` 及其唯一索引后再接受任务。默认内存适配器不受支持。记录保留创建者归属，不随用户删除级联清除。

## 私有文件存储合同

`GenerationAssetStore` 有两个必需方法：

- `readInput({ userId, ref, signal })`：先校验用户对素材的访问权，再返回 `{ bytes: Uint8Array, mediaType, url? }`。仅支持 PNG、JPEG、WebP 输入；`url` 仅在特定 fal 模型需要时提供，由宿主签发。不要把请求中的任意 URL 直接交给服务端下载。
- `put({ key, userId, mediaType, body, signal })`：完整消费并原子保存有大小限制的流，返回 `{ ref }`。同一 `key` 重试必须返回同一份有效文件引用；写入失败抛异常，不能返回占位成功。文件保持私有，存储自身也需执行超时、大小和访问保护。

`get()` 仅在允许交付时返回文件引用，不返回供应商临时 URL。网站签发短期下载地址前，必须再次用当前用户调用 `get()`，确认引用仍在允许返回的资产列表；不要仅凭存储对象归属绕过审核。已签发地址的撤销和过期由宿主存储实现。

供应商 HTTP 响应、文件流、输入字节数均有上限。下载仅允许配置的 HTTPS 域名，逐跳检查重定向，凭据只发送给供应商 API 原始域名。`downloadHosts` 可以补充实际使用的 CDN；以 `.` 开头表示允许其子域名。不要添加用户可控域名或内部地址。

同步图片通常返回 base64 且没有可回查的任务 ID。为恢复对象存储失败，`generationAttempt.result` 会暂存受 `maxResultBytes` 限制的原始结果；文件全部保存后清除该暂存。数据库、备份及未处理任务因此也应按私密素材保护。异步结果暂存的是供应商输出描述。若进程在收到结果并成功持久化之前退出，仍可能进入待对账，不能承诺跨供应商的绝对一次执行。

## 浏览器与任务调度

```ts
import { createAuthClient } from "@app/auth-sdk/react";
import { generationClient } from "@app/auth-sdk/generation/client";

export const client = createAuthClient({ plugins: [generationClient()] });

const result = await client.generation.create({
  model: "product-image",
  mode: "text-to-image",
  prompt: "白色背景上的产品展示图",
  idempotencyKey: crypto.randomUUID(),
});
// 处理 result.error；同一次未确认提交重试保留原 UUID 和全部载荷。
if (result.data) {
  const state = await client.generation.get({ query: { jobId: result.data.job.id } });
}
```

可用方法：`models()`、`create()`、`get()`、`list({ query: { limit, offset } })`、`cancel({ jobId })`。模型列表包括操作、输入上限、参数 JSON Schema 与取消能力；客户端只按实际能力展示选项。所有公开接口要求当前有效会话，校验账号禁用和模拟登录；创建者只能查看、取消自己的任务。他人任务返回 404，未知参数返回 400，幂等键改载荷返回 409。

宿主调度器周期调用 `await auth.api.runGenerationTasks()`。单轮最多处理 `batchSize` 条任务，多个宿主进程通过数据库租约协调；持久化错误向调用方抛出，宿主应记录本次调度失败。浏览器只查询本地状态，不直接轮询供应商。需要持续处理时必须部署宿主调度器，SDK 不在请求返回后启动悬空后台 Promise。

默认限额，可通过 `limits` 覆盖（也可由宿主从环境变量读取）：

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `operationTimeoutMs` | 120000 | 单次处理的外部调用总期限 |
| `leaseMs` | 180000 | 必须大于处理期限 |
| `pollIntervalMs` | 10000 | 查询、文件保存和审核暂缓后的下次执行间隔 |
| `taskTimeoutMs` | 86400000 | 超期任务暂停处理，已提交任务进入待对账 |
| `batchSize` | 20 | 单轮任务数，上限 100 |
| `maxInputBytes` | 20971520 | 每张输入图片的最大字节数 |
| `maxOutputBytes` | 268435456 | 每个结果文件的最大字节数 |
| `maxResultBytes` | 41943040 | SQL 临时结果的最大字节数 |

供应商另有 `maxResponseBytes`，默认 41943040。调整内联图片大小时一起核对响应和临时结果上限。首版每轮顺序处理；调度宿主应给整轮足够的执行时间，或降低批次。Serverless 可每次处理一条并由受保护的调度入口重复触发。

## 回调、取消与恢复

供应商回调路由由宿主挂载并验证签名、防重放，验证后调用：

```ts
await auth.api.notifyGenerationTask({
  body: { providerId, taskId, eventId },
});
```

通知按供应商连接与事件 ID 去重，只唤醒已有任务的认证轮询，不接受通知携带的成功状态或下载地址。该函数是 server-only，没有公开 HTTP 路由；签名验证不由这个唤醒接口代替。持久化或验证失败返回非 2xx，让供应商重试；SDK 不强制依赖回调，宿主轮询也能完成任务。

取消排队任务会阻止提交；运行任务只记录取消意图，供应商确认后才记为 `cancelled`。fal 的取消确认请求本身不表示生成已经停止，之后仍会轮询。没有取消能力的生成器继续查询实际结果。已完成任务不会因为迟到取消而伪装成失败。

提交超时、遗失的提交租约、超期运行及非法供应商结果进入 `needs_reconciliation`，不自动重提、切换供应商或退款。受信任的宿主管理流程先回查供应商，再调用：

```ts
const state = await auth.api.inspectGenerationTask({ body: { jobId } });
await auth.api.reconcileGenerationTask({
  body: { jobId, expectedRevision: state.revision, outcome: "running", taskId },
});
```

确认失败时使用 `outcome: "failed"`；已生成但文件/审核处理超期的任务使用 `outcome: "resume"`，只恢复已有结果的处理。不要用浏览器声明或无法确认的超时当作“供应商未执行”的证明。一次任务只执行一次生成提交；用户明确再生成时创建新任务和新幂等键。

## 审核与积分

`policy` 可接网站现有审核流程：`beforeGenerate({ jobId, attemptId, userId, request, inputs, signal })` 和 `beforeDeliver({ ..., assets })` 返回 `allow` / `block` / `review`；`authorizeDelivery({ ..., assets })` 每次读取文件引用时返回当前是否允许交付。启用审核时应同时实现三个方法，异常拒绝放行，不将供应商成功等同于允许交付。

接当前 `@app/auth-sdk/moderation` 时，由宿主把本插件的 jobId / attemptId 绑定到审核上下文，生成前执行 prompt、input 检查与 generate 授权；生成完成后回流真实 provider 结果、执行 output / presentation 检查，并在 authorizeDelivery 中执行 deliver 授权。审核上下文、素材版本和可信身份由宿主建立，不应把客户端的审核状态直接透传。插件本身不增加对审核包的反向依赖；未配置 `policy` 表示该宿主未启用此审核流程。

积分预占、结算、释放与后台界面尚未实现；生成插件不会自动扣减 credits，也不会调用 PayPal / Stripe。启用收费产品前，宿主应先接入真实的限流、预算、权益及积分预占流程，不能仅查余额后异步扣减。

## 适配 fal 和其他生成器

fal 每个端点提供 `FalModelAdapter`：`queueModel` 指定状态/结果队列根路径，`mapInput()` 生成所选模型的请求，`parseOutput()` 以该模型的真实 schema 校验并转换输出。不要把所有型号都假定为同一种 `images` / `video` 返回结构，也不要让浏览器决定回调地址或调用端点。

自定义 `GenerationProvider` 实现 `submit()`，异步提供 `poll()`；可选 `cancel()`、`readOutput()`。认证、请求路径和媒体来源验证由适配器负责；返回值再次经统一 schema 验证。确定未执行的提交拒绝可抛 `generationProviderError("rejected", status)`；任何无法确认是否已执行的错误使用 `"unknown"`。供应商必须沿用保存的任务 ID 查询，不可在 poll 中偷偷创建新任务。

官方协议参考：[OpenAI Images](https://developers.openai.com/api/docs/guides/image-generation)、[Google Interactions](https://ai.google.dev/api/interactions-api)、[Omni 视频](https://ai.google.dev/gemini-api/docs/omni)、[Google generateContent](https://ai.google.dev/api/generate-content)、[Veo 视频](https://ai.google.dev/gemini-api/docs/veo)、[fal Queue](https://fal.ai/docs/documentation/model-apis/inference/queue)。这些链接用于核对协议，不代表已经验证某个账号具备全部模型权限。

## 验证

仓库根目录执行 `pnpm exec vitest run packages/generation/test`、`pnpm typecheck`、`pnpm build:sdk`、`pnpm test:sdk`、`pnpm test:packaging`。测试使用真实 SQLite 与明确的供应商 HTTP 测试响应，不会发起收费生成。生产 PostgreSQL、真实供应商账号和对象存储的联调应在网站接入时执行。
