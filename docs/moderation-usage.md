# 内容审核插件接入

入口为 `@app/auth-sdk/moderation`。这是服务端模块；SDK 不启动审核服务或 Worker，不向浏览器提供审核客户端。设计背景见 [设计文档](./moderation-design.md)，实际合同以导出的 TypeScript 类型为准。

## 安装与数据库

使用仓库的 `pnpm pack:sdk` 打包、在站点安装产物。已有认证实例加入 `moderation(options)`，在原生 Kysely SQL 路径使用 `getMigrations(auth.options)` 显式生成并执行迁移；自定义存储的建表与迁移由宿主完成。新增两张表：

| 表 | 内容 |
| --- | --- |
| `moderationRecord` | 租户隔离的策略/能力快照、尝试、不可变决策/事件，以及可变命令、动作、声明、计数器和清理回执 |
| `moderationTenantLock` | 在真实 SQL 事务内串行化同租户短写入，防止并发检查与撤权交错 |

`tenantId + kind + recordKey` 有唯一索引。检测调用和宿主网络动作在事务外执行；提交时核对版本及租约。首期按租户加写锁，吞吐上限需要在站点真实负载下测量。插件构造不会自动执行生产迁移。

支持独立的 `createModeration({ storage, ...options })`；已有 Better Auth SQL 适配器可用 `createModerationStore((await auth.$context).adapter)`。认证实例必须先注册 `moderation` 的 schema 或等价的 `moderationSchema`，迁移后再用独立模块。内存适配器和未配置真实事务的适配器会被拒绝；自定义 `ModerationStorage` 必须提供同等事务、唯一性、CAS 和租户隔离保证。

## 服务端配置

`ModerationOptions` 要求显式传入以下能力，没有默认放行适配器：

| 配置 | 宿主职责 |
| --- | --- |
| `authorize(context, permission)` | 核验租户、用户、操作者和权限；复核、导出、Worker、声明验证须分权 |
| `resolvePolicy(context)` | 返回平台底线及可选租户附加策略；不得信任浏览器策略 |
| `resolveControls(context)` | 版本化 `block_all` 和 `disabled_detectors`；开关保留在服务端 |
| `validateContent(context, items, revision, digest)` | 核验素材所有权/源素材访问权限、不可变版本，以及完整内容包与上下文摘要的一致性 |
| `resolveRestrictedSignal(context, items, signal)` | 进入通用检测器前核验受限信号；不可用会进入 review |
| `handoffRestricted`（可选） | 对已知/疑似受限材料幂等交接；缺少或失败时保持隔离，不能普通复核放行 |
| `validateConsent`（有凭证时必需） | 核验声明、被审素材、实际主体、用途、期限的关联；声明文字本身不算验证 |
| `resolveAbuseContext`（可选） | 提供可信设备/支付引用及 IP 摘要；缺少时只有认证账号特征可用 |
| `executeAction`（有处罚/验证动作时必需） | 以 `action_id` 幂等执行封禁、终止会话、降额或验证，并返回真实回执 |
| `erase`（清理外部引用时必需） | 以 `cleanup_id + resource_ref` 幂等删除普通素材/证据；检查共享引用，仍被其他有效尝试/主体使用时不得物理删除，须失败保留 partial |

`boundary_timeout_ms` 是宿主适配器的超时；`evidence_secret` 是至少 32 字符的随机服务端 HMAC 密钥，不入库、不发前端。密钥改变会影响命令指纹和风控桶，需要协调轮换，不能滚动实例各用不同值。租户/用户/操作者 ID、幂等键、版本和私有引用使用 `[a-zA-Z0-9][a-zA-Z0-9_.:-]*`，最长 256 字符；`context_digest` 是 64 位小写十六进制 SHA-256。

平台策略必须有至少一条 `required: true, mode: "enforce"` 内容规则；所有平台规则均强制执行。租户只能添加不同 ID 的规则。业务必须配置完整的必查类别和模态；SDK 不根据“视频站”等业务名称猜测底线。专用能力不齐时，把必查项保留在策略中，缺口会进入 review。

一条规则的结构如下；这是单项规则示例，不是完整站点底线：

```ts
import type { PolicyRule } from "@app/auth-sdk/moderation";

const sexualText: PolicyRule = {
  id: "sexual-text-v1",
  category: "sexual",
  layer: "safety",
  stages: ["prompt", "input", "output", "presentation", "reuse"],
  modalities: ["text"],
  minimum_scope: "text.semantic",
  required: true,
  mode: "enforce",
  detector_ids: ["openai-moderation"],
  threshold: null, // 使用原生类别判定；数值阈值只能额外收紧
  block_level: "soft",
  action: null,
  public_description: "禁止色情内容。",
};
```

平台还必须配置 `allow_empty_input` 和所有 `PolicyLimits`：`max_items`、`max_text_chars`、`max_page_size`、`max_export_records`、`detector_timeout_ms`、`command_lease_ms`、`review_ttl_ms`、`authorization_ttl_ms`、`action_lease_ms`、`action_retry_ms`、`action_max_attempts`、`retention_ms`。超时、租约、有效期、重试间隔和留存期限均为毫秒，其余为数量；`max_text_chars` 按 JavaScript 字符串长度计。命令租约必须长于单次检测超时；它同时限制整次评估。数值应按站点负载设置，不在 SDK 内隐式补值。

## 检测器

SDK 0.3.0 新增 `createSeeAPIModerationDetector`，支持 SeeAPI 的文字、图片 2.0 与供应商视频抽样帧审核。视频使用独立 `video.provider_sampled_frames` 范围，不满足宿主抽帧或音轨规则。幂等执行标识由正常 check/evaluate 自动生成；新增 `provider_evidence` 保存不含素材 URL 的原生参数/标签/抽样证据，旧记录无需迁移。配置、输入限制及与 Kie.ai 的联动见 [SeeAPI / Kie.ai 接入](./seeapi-kie-usage.md)。当前供应商实测未完成。

`createOpenAIModerationDetector` 要求 `api_key`、完整 HTTPS `endpoint`、`model` 和 `resolveImage(asset_ref, signal)`。`endpoint` 来自受信服务端配置；通常为 `https://api.openai.com/v1/moderations`。支持 `omni-moderation-latest` 或固定的 `omni-moderation-2024-09-26`。`resolveImage` 将已经过所有权验证的私有引用转换为受控 HTTPS URL 或 `data:image/...`。不要把用户提交的任意 URL 直接交给它。

宿主若提供 `resolveVideo`，可审核版本绑定的抽样帧；必须返回 `VideoInspectionPlan` 与 `VideoInspectionManifest`，包含采样率、首尾帧、场景采样声明、最大时长/帧数、实际帧列表和缺口。SDK 核验计划及采样覆盖，再检查每个必需帧。抽帧实现由宿主负责；音轨审核仍不支持，要求音轨时返回 missing。抽样检查不能声明完整逐帧覆盖。

| 检测器 | 实际范围 |
| --- | --- |
| OpenAI 文字 | `text.semantic`，仅原生支持的类别 |
| OpenAI 图片 | `image.original`，sexual、自残及暴力相关原生类别 |
| OpenAI 视频帧 | `video.sampled_frames`，与图片类别相同 |
| `createTextRulesDetector({ version, literal_terms })` | `text.rules`，可选 `id`，文字字面匹配；无命中不替代语义检查 |
| 专用 `ModerationDetector` | 显式声明 layer、category、modality、inspection_scope；缺失不伪造通过 |

`sexual/minors` 的 OpenAI 覆盖仅限文本；图片/音频的零分不能放行。身份、克隆、非自愿裸体、版权、真实性和专项儿童安全没有内置服务商。平台规则须保留这些真实需求，由专用检测器接入。

`detector_ids` 按顺序主备执行，只补足技术失败或缺失覆盖；已有命中不被备用通过覆盖。备用必须满足同层、同类别、同模态、同范围。每条规则只有一个 `threshold`；不同供应商的分数不能直接比较，应使用原生判定或由专用适配器明确校准。`native_flagged`、score、threshold、模型、类别和版本分别保存。

## 正常调用链

独立模块通过 `createModeration(options)` 使用全部方法。Better Auth 桥接只提供 `auth.api.moderateContent({ body })` 和 `auth.api.authorizeModerationOperation({ body })`，二者均为 serverOnly，分别对应 evaluate 和 authorizeOperation。其余方法用共享 SQL 存储的独立模块调用。宿主自行包装公开接口时，必须完成认证、CSRF、限流及安全投影。

1. 从认证会话生成 `TrustedContext`。宿主创建 job/attempt，每次真实 provider 调用和重试使用新 attempt。
2. `evaluate` 首次用 `expected_state_revision: 0` 创建尝试；按返回版本推进后续阶段。素材和上下文变更新建尝试。
3. generation 必须完成 `prompt/generate` 与 `input/generate`，再调用 `authorizeOperation(generate)`。只有 `permit: true` 才调用 provider。
4. `recordProviderResult` 记录 `succeeded | policy_refused | technical_error`；只有政策拒绝可写 refused outcome，超时/5xx 属技术失败。
5. 生成物留在私有存储，完成 `output/publish`、`presentation/publish`。标题、描述、alt、文件名和分享文案作为独立文字 item 提交。
6. 最终 `authorizeOperation(deliver)` 通过后才签发短时链接，记录 `recordOutcome` 和 `recordDelivery`。

publication 使用 `input/publish → presentation/publish`；reuse 使用 `reuse/reuse → presentation/publish`，并提交 `source_decision_ids`。新主体/用途仍须重新检查，授权时会递归检查源决策、撤权和凭证。没有上传素材时，只有平台 `allow_empty_input` 明确允许，空 input 才可通过。

声明用途中的 deliver 按 publish 校验。源凭证必须同时覆盖源操作和目标操作；授权时 `validateConsent` 接收目标 context、源声明以及目标与递归源尝试各阶段的媒体并集。跨用户复用时 context.subject_id 与 consent.subject_id 可以不同，宿主须验证真实的转用授权关系，不能只按主体相等或原始用途判断。

每次 `evaluate` 提交 `context, job_id, attempt_id, attempt_kind, stage, operation, items, content_revision, context_digest, consent_ids, source_decision_ids, expected_state_revision, idempotency_key`。item 的文本为 `text`，媒体为不可变 `asset_ref`，均须带 `item_id, revision, field, modality`。不能传入自定义 state、permit 或 provider_status 来跳过检查。

`check` 支持指定 layers/categories，但只返回独立诊断报告；`evaluate` 生成的 allow 也只是阶段结论。唯一操作许可来自 `authorizeOperation`，必须紧邻实际副作用调用。同一幂等键只重放原命令，改请求体会冲突；CAS 冲突需重新读取当前版本。旧的拒绝授权键不会随着状态改变自动变成许可，重新授权使用新键。许可过期、策略/能力/阶段更新或撤权后必须重新核验，旧键不能续期。

普通评估不能覆盖已 block 的阶段。`resolveReview` 同时需要 review 和 evaluate 权限，指定当前 `expected_decision_id`、原因码和完整 evaluation，重新运行检测；没有“人工填 allow”入口。成功命令可幂等重放。技术故障可在原 review 期限内重新评估，期限不会续期；过期后必须新建尝试。举报撤权只能由对应目标的复核解除，其他撤权原因仍然有效。上游决策变更后，下游必须重新评估，不能沿用旧前置引用。

legal_hold 先专用交接，不进通用检测器、普通 review/证据导出或普通清理；本模块不留材料副本。宿主不要把内部决策完整回传前端，尤其是阈值、私有媒体引用和受限状态详情。

## 回流、运营与清理

| 方法 | 作用 |
| --- | --- |
| `getCapabilities({ context, attempt_kind?, stage?, modality? })` | 返回实际能力矩阵与强制规则 readiness；shadow 不影响正式就绪判断，实际操作仍须授权 |
| `recordOutcome` | accepted/refused/output_blocked 三值终态，检查关联的 provider 与决策；不覆盖原 outcome |
| `recordDelivery` | released/withheld/revoked 事实；released 必须对应未过期的有效授权及相同版本，异常留审计并撤权 |
| `recordFeedback` | report/appeal 追加事件，绑定目标决策并撤回交付权限 |
| `recordConsent` / `verifyConsent` / `revokeConsent` | 声明与验证分开；验证只能缩小原声明用途和有效期，变更/撤回使绑定尝试失效 |
| `listReviews` / `expireReviews` | 分页查询当前待复核项；超时追加 soft-block 决策，保留原记录 |
| `runPendingActions` | 有界批处理、租约、幂等动作和回执，失败重试有上限；没有真实回执不能假称处置完成 |
| `getPublicPolicy({ context })` | 从同一生效策略输出类别和公开说明，语言由宿主的 `public_description` 选择 |
| `exportEvidence({ context, from, to })` | 受限时间窗及条数上限的脱敏 JSONL 和统计；超限拆分时间窗，不截断伪称完整 |
| `cleanupData` | 按 subject 或已过留存期的 before 清理；同一 cleanup_id 固定范围，每批独立键并沿回执游标推进 |

由宿主调度 `expireReviews`、`runPendingActions` 和 `cleanupData`，处理所有分页，包括空结果但仍有 `next_cursor` 的页；SDK 不自建定时器。review 在等待期间已经拒绝操作，不依赖 Worker 及时运行才能拦截。清理响应未知时用原批次键重试；收到 failed/partial 回执且 failed>0 时，保持 cleanup_id 与回执游标，换新批次键重试失败范围。原键只重放旧回执。受限例外单独统计，不删除专用证据。

证据导出区分原始 outcome、当前决策和实际交付事件；统计窗口及当前状态口径在回执中声明。导出使用字段白名单，不包含 prompt、原始媒体、用户/IP/支付标识、凭证证据引用或 legal_hold 详情。它证明审核执行情况，不保证支付渠道接受站点业务。

账号/IP/设备/支付的行为规则使用持久化固定窗口计数；一次 attempt、重复网络请求和主备检测不会倍增请求次数。只产生 limit/challenge/review，不能从共享 IP 直接推断封号。平台安全底线始终 enforce；租户附加规则可先 shadow，查看 `would_*` 后再启用，不能把所有审核关掉观察一周。

## 宿主交付边界与验证状态

URL 抓取、SSRF 防护、受控存储、EXIF 清理、短时签名和签名 URL 日志脱敏由宿主实现。签名 URL 的有效期不能长于审核许可；普通对象存储链接无法立即撤回，需要即时撤回时使用每次请求重新授权的交付代理。授权与真正的 provider 调用/外部交付不能跨系统原子提交，宿主要缩短间隔并使用业务幂等键。

本次没有生产迁移、部署、真实 OpenAI 调用或专用服务商联调。SQLite 覆盖真实事务回滚、CAS、并发和完整生命周期；PostgreSQL 的生产并发验收须在独立测试库进行。不能把接口和本地测试通过等同于某站点已满足完整审核底线。

2026-10-20 本地验证：`pnpm typecheck`、`pnpm build:sdk`、最终 SDK 入口构建通过；`pnpm test:sdk` 当前工作区 400 项通过；`pnpm test:packaging` 2 项通过，包含安装包入口运行时导入和 NodeNext 类型消费。审核源码、测试及打包测试的 Biome 检查通过。PostgreSQL、真实供应商、对象存储和实际账号处置尚未验证。
