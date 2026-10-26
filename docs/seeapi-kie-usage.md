# SeeAPI 审核与 Kie.ai 生成

SDK 0.3.0 提供可选服务端适配器，保留现有 OpenAI / Google / fal 接口。所有凭据由网站服务端加载；SDK 不自动读取环境文件、启动 Worker、开放回调路由或启用审核。当前供应商实测未完成；测试使用明确的 HTTP 边界，不代表生产验收通过。

## SeeAPI：文本、图片和视频

```ts
import { createSeeAPIModerationDetector } from "@app/auth-sdk/moderation";

const seeapi = createSeeAPIModerationDetector({
  api_key: process.env.SEEAPI_API_KEY!,
  base_url: process.env.SEEAPI_BASE_URL!, // https://api.seeapi.com/，不含 /v1
  version: process.env.SEEAPI_DETECTOR_VERSION!,
  text_threshold: 0.3,
  image_threshold: 0.5,
  video_num_frames: 8,
  video_threshold_offset: 0.02,
  poll_interval_ms: 2000,
  // 由网站实现：先验证租户、所有权和不可变版本，再签发有效期足够的地址。
  resolveImage: async (item, signal) => privateMedia.resolveImage(item, signal),
  resolveVideo: async (item, signal) => privateMedia.resolveVideo(item, signal),
});
```

将 `seeapi` 放入已有 `createModeration({ ...hostOptions, detectors })` 的 `detectors`，并在平台规则中使用 `detector_ids: [seeapi.id]`。宿主仍须提供授权、所有权验证、受限信号检查、真实 SQL 存储及完整平台策略，见 [审核接入](./moderation-usage.md)。示例环境变量见 `packages/app-sdk/src/moderation/.env.example`；阈值和解析方式变化时递增 detector version。

| 内容 | 原生模型 | 声明范围 | 宿主解析结果 |
| --- | --- | --- | --- |
| 文本 | `text-nsfw-filter` | `text.semantic` | 直接提交文本，最长 20,000 字符 |
| 图片 | `nsfw-filter-2` | `image.original` | `{url, revision, media_type, size_bytes, width, height}` |
| 视频 | `video-nsfw-filter` | `video.provider_sampled_frames` | `{url, revision, media_type, size_bytes, duration_ms}` |

文本类别映射：`sexual` 合并 `sexual_explicit` / `sexual_suggestive`；`sexual/minors` 对应 `sexual_minors`；`self-harm` 对应 `self_harm`；violence、hate、harassment 同名。每类只检查原生实际返回的字段；请求未返回的类别保持未覆盖。图片和视频支持 sexual 及可用的 sexual/minors 字段，不宣称覆盖暴力、音轨、身份、版权或专用儿童安全服务。

图片只支持 PNG/JPEG，最大 16 MiB，宽高各 256–8192，像素总量 78,400–32,000,000。图片可使用 HTTPS URL 或对应 MIME 的 base64 data URL。WebP 等格式需宿主生成经验证、版本绑定的合规衍生素材，不能只改扩展名或 MIME。视频只支持 HTTPS MP4/MOV，SDK 按 100,000,000 字节、30,000 毫秒的保守上限验证；超限进入失败/待审核，不截断。宿主返回的 revision 必须等于审核 item 的 revision。

默认文字阈值 0.3、图片阈值 0.5、视频 8 帧及 threshold_offset 0.02；special-care 始终严格处理。文字/图片阈值可在 0.01–0.99 设置，视频帧数 8–32、offset 0–0.1。阈值由服务端配置，原生标记不会被更宽松的本地阈值覆盖；图片与视频没有置信分数时保存 null。模型分类存在误报和漏报，部署前需按自身样本校准。

使用 `/v1/inferences` 创建和查询。202、queued、processing、null 结果都不是审核通过；余额不足、超时、格式错误、字段缺失保持失败/待审核。执行受 `detector_timeout_ms` 和 command lease 约束，未完成后按现有复核流程处理。SDK 不另外启动审核队列。

编排器传给 detector 的新增 `execution_key` 为带租户隔离的 HMAC，不向供应商发送租户/用户 ID；SeeAPI 根据命令、素材版本和检查项生成固定请求键。429 / 503 在超时范围内最多重试两次，沿用相同请求体与幂等键，并遵守 Retry-After。网络错误不擅自重提；重放原命令须保持请求体。签名 URL 改变导致 409 时显式失败，不换键制造重复收费。直接调用该 detector.check 时也必须提供稳定的服务端 execution_key；正常使用 check/evaluate 会自动提供。

视频保留原生报告版本、请求/实际帧数、抽样完整性、逐帧时间和标签，存入新增 `provider_evidence`，不会伪造原宿主抽帧 manifest，也不会保存供应商返回的帧图片 URL。special 字段缺失不算该类别检查通过；不完整报告中的有效命中仍然阻断。`content_policy_blocked` 保存拒绝事实而不伪造帧报告。special-care 属风险标记，不是已验证事实，也不能替代宿主原有受限信号和专用儿童安全链。

## Kie.ai：Market 图片和视频

```ts
import { generation } from "@app/auth-sdk/generation";
import {
  createKieGenerationProvider,
  kieNanoBanana2Adapter, kieNanoBanana2Parameters,
  kieGrokTextToVideoAdapter, kieGrokImageToVideoAdapter, kieGrokVideoParameters,
} from "@app/auth-sdk/generation/providers/kie";

const kie = createKieGenerationProvider({
  apiKey: process.env.GENERATION_KIE_API_KEY!,
  baseURL: process.env.GENERATION_KIE_BASE_URL!, // https://api.kie.ai/api/v1/
  downloadHosts: configuredKieDownloadHosts, // 服务端白名单，不接受浏览器传入
  models: {
    "nano-banana-2": kieNanoBanana2Adapter,
    "grok-imagine/text-to-video": kieGrokTextToVideoAdapter,
    "grok-imagine/image-to-video": kieGrokImageToVideoAdapter,
  },
});
const plugin = generation({
  providers: [kie],
  models: [
    { id: "kie-image", providerId: kie.id, model: "nano-banana-2", version: "1",
      kind: "image", modes: ["text-to-image", "image-to-image"], maxInputAssets: 1,
      parameters: kieNanoBanana2Parameters },
    { id: "kie-video-text", providerId: kie.id, model: "grok-imagine/text-to-video", version: "1",
      kind: "video", modes: ["text-to-video"], maxInputAssets: 0,
      parameters: kieGrokVideoParameters },
    { id: "kie-video-image", providerId: kie.id, model: "grok-imagine/image-to-video", version: "1",
      kind: "video", modes: ["image-to-video"], maxInputAssets: 1,
      parameters: kieGrokVideoParameters },
  ],
  assets: privateGenerationAssets,
  policy: moderationPolicy, // 按下一节连接网站审核
});
// 将 plugin 加入已有 betterAuth.plugins，完成迁移后由宿主调度 runGenerationTasks。
```

上例中的私有存储和调度合同见 [生成接入](../packages/generation/README.md)。输入图由 readInput 验证所有权并提供 HTTPS url；SDK 不自动上传文件或将任意用户 URL 当作可信素材。Nano Banana 示例固定 PNG 输出，支持单张参考图；Grok 示例限制 normal、6 秒、480p/720p，输出 MP4，视频自带音轨。若业务要求音轨审核，必须另接实际能力，不能以帧审核替代。

其他 Market 模型在服务端注册 `KieModelAdapter`：`mapInput(call)` 显式映射参数，`parseOutput(native)` 校验 JSON 结果并返回带正确 MIME 的文件列表，再配套注册模型自己的参数 schema 和版本。内置示例是保守配置，不表示平台所有型号、参数或操作均已支持。改变型号/输出格式须同时修改映射、schema、MIME 和版本。

使用 `jobs/createTask` 和 `jobs/recordInfo`，同时验证 HTTP 与 code。waiting/queuing/generating 继续轮询；success 才解析 resultJson，fail 按 provider_failed 处理，不凭错误文案猜测政策拒绝。提交超时、5xx 或非法创建响应进入 needs_reconciliation，不承诺 Kie.ai 有未文档化的幂等能力，也不自动重提。当前不提供远端取消方法；运行中的取消意图保留，继续查询真实结果。

下载只允许配置的 HTTPS 域名及逐跳通过验证的重定向，API 凭据不转发给 CDN。轮询使用已保存的任务 ID，供应商成功只说明生成完成；私有文件保存、审核和授权全部完成后才能交付。首期不创建公共 webhook 路由。若宿主自行接入回调，须验证签名、防重放后仅调用既有 notifyGenerationTask 唤醒认证回查，不能接受回调直接指定成功状态或下载地址。

## 连接 generation.policy

由宿主建立可信 context、不可变内容版本与 context_digest，并使用共享的审核服务和 SQL 状态。必须实现全部三个回调：

1. `beforeGenerate`：为当前 jobId / attemptId 执行 `evaluate(prompt, generate)` 与 `evaluate(input, generate)`，再执行 `authorizeOperation(generate)`；只有 permit 为 true 才返回 allow。
2. `beforeDeliver`：Worker 已取得供应商成功结果并保存私有文件，此时回流真实 `recordProviderResult(succeeded)`，检查 `output/publish` 和 `presentation/publish`；block / legal_hold 阻止交付，review 或异常保持待审核。
3. `authorizeDelivery`：每次读取结果调用 `authorizeOperation(deliver)`，以当前策略、凭证和撤权状态为准；不能缓存历史 allow 代替授权。

每次 evaluate 从审核 SQL 状态读取当前 revision，以 CAS 更新。宿主须持久保存每个阶段的完整命令请求和幂等键，重放时保持原请求体；不得读取新 revision 后复用旧命令键。已有 review 用 resolveReview 和 expected_decision_id 处理，不使用普通 evaluate 覆盖旧拒绝。素材、用途或元数据变化建立新 attempt。

生成存储 ref 可能带斜杠，而审核 asset_ref 要求受限标识符。使用例如 `generation:<asset.id>` 的不透明审核引用，由宿主在 SQL 中映射回私有 ref，并在 validateContent / resolveImage / resolveVideo 核对所有权和版本，不能放宽原审核引用校验。

完整可执行联动回归见 [seeapi-kie-generation.test.ts](../packages/app-sdk/test/seeapi-kie-generation.test.ts)：真实 SQLite 的任务、审核、CAS、私有存储处理与交付授权，仅两家上游 HTTP 为显式合成响应；覆盖通过、阻断、余额不足、异步未完成以及放行后撤权。测试夹具不是网站可直接使用的授权或存储实现。

## 官方合同与验收边界

资料核对日期：2026-10-26。

- [SeeAPI 文字](https://www.seeapi.com/docs/text-nsfw-filter/text-moderation/)、[图片 2.0](https://www.seeapi.com/docs/nsfw-filter-2/image-moderation/)、[视频](https://www.seeapi.com/docs/video-nsfw-filter/video-moderation/)。
- [Kie.ai 任务查询](https://docs.kie.ai/market/common/get-task-detail)、[Nano Banana 2](https://docs.kie.ai/market/google/nanobanana2)、[Grok 文生视频](https://docs.kie.ai/market/grok-imagine/text-to-video)、[Grok 图生视频](https://docs.kie.ai/market/grok-imagine/image-to-video)、[回调签名](https://docs.kie.ai/common-api/webhook-verification)。

自动化测试不调用真实供应商、不扣费；真实供应商、阈值校准、真实私有素材 URL/CDN 及站点部署尚未验收。本次仅 SDK 分发，不修改 SEO-Worker，不代网站开启服务或执行生产迁移。
