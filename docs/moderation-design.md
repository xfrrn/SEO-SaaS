# 内容审核插件设计

状态：首期代码已实现，生产验收未完成。设计版本：v2.1（审阅修订）。更新日期：2026-10-20。

本文保留确认的目标、首期范围和逻辑合同；实际 TypeScript API 与宿主责任见 [接入说明](./moderation-usage.md) 及 `packages/app-sdk/src/moderation.ts`。当前已提供服务端入口、SQL schema 和实现；未对生产数据库执行迁移或部署。PostgreSQL 生产并发、真实供应商和站点交付链尚未验收，不将本地逻辑测试倒推为生产可放行。

2026-10-26 增量实现（SDK 0.3.0）：新增 SeeAPI 文字、图片和供应商视频抽样检测，使用独立 `video.provider_sampled_frames` 范围；不替代下文宿主抽帧及音轨要求。审核命令提供不透明租户隔离执行标识，新增有界 `provider_evidence` JSON 证据，无需新增表。与 Kie.ai 生成的联动及真实供应商未验收边界见 [接入说明](./seeapi-kie-usage.md)。

本轮实现明确以下映射与收敛：

- 逻辑记录保存在两张物理表 `moderationRecord` / `moderationTenantLock`；使用 SQL 真事务与租户短写锁，不新增一组业务专表。
- Better Auth 桥接仅提供 `moderateContent` / `authorizeModerationOperation` 两个 serverOnly 方法；完整生命周期使用共享存储的 `createModeration`，不自动开放 HTTP 路由。
- 能力就绪可按 attempt_kind、stage、modality 查询；CheckCoverage 显式带 mode，shadow 缺口不影响 enforce 就绪，亦不能充当强制覆盖。
- `native_flagged` 保留原生判定；单项数值阈值只能额外收紧。主备分数须可比较，其他情况由专用适配器校准或使用原生判定，不自动推断跨供应商分数关系。
- block 的普通重评拒绝，必须新建尝试或受权复核；review 首次期限保留且提交前再核验。复核先幂等、再 CAS，只解除对应举报目标，不清除 provider/凭证/清理等其他撤权。
- AUP 输出配置的 public_description，首期没有内置翻译；同步有界 JSONL 导出超限报错，不伪称导出完整。无抽帧基础设施、人工页面或后台定时服务。

## 1. 目标与边界

在 `@app/auth-sdk` 提供可独立使用的服务端审核能力，按业务调用检测层，同时通过统一编排保证平台底线。审核覆盖生成前、生成后、展示编辑及素材二次使用，并留下可追溯的策略、决策、回流和处置记录。

固定约束：

- 检查点与检测能力分开；某层通过不代表完整审核通过。
- 不能用 `safe: true` 掩盖缺失；每项要求均有覆盖状态。
- 任一拒绝不能被其他检测器的通过覆盖；不以多数投票放行。
- 局部检测报告不是生成、发布或下载许可。
- 失败、待复核、证据写入失败时均不得交付。
- 历史决策不可覆盖；举报、申诉、复核追加事件和新决策。
- 平台底线不能被租户、浏览器、shadow mode 或缓存关闭。
- 审核证据证明执行过程，不保证支付渠道接受业务类型。

插件负责检测编排、策略执行、证据持久化合同及授权判断；宿主负责身份认证、业务任务、私有素材存储、实际生成调用、媒体提取、交付和账号处置。复用现有 Better Auth、Admin、Business 和宿主 Worker，不创建独立常驻审核服务，不修改认证核心。

## 2. 首期范围

| 能力 | 首期交付目标 | 明确限制 |
| --- | --- | --- |
| 服务端入口 | `@app/auth-sdk/moderation`，独立服务端模块及 Better Auth 桥接 | 无浏览器审核客户端、独立常驻服务 |
| 检查与编排 | 五个检查点、按层检查、平台底线聚合、短路、统一操作授权、fail-closed | 检测结论不能代替生成或交付授权 |
| 本地规则 | 可配置文字规则、原因码和规则版本 | 无命中只说明规则未命中，不替代语义检测 |
| OpenAI | 文本、图片、宿主提供的视频帧；保留原始类别和模态覆盖 | 不提供专用 CSAM、真人身份、同意、版权或完整音视频检测 |
| 专用能力 | 身份、版权、真实性、指令安全及儿童安全检测器合同 | 没有服务商时明确 unsupported，不提供空实现或默认成功 |
| 行为层 | 持久化的请求频次、重复命中、边缘试探规则；限额、验证、review | 首期不做设备指纹采集、支付风控模型或跨站用户画像 |
| 授权凭证 | 声明、证明引用、用途、期限、撤回记录 | 声明不等于真实授权已经验证 |
| 回流与证据 | provider 事件、三值 outcome、举报申诉、版本化决策、脱敏导出 | 不把 provider 拒绝当成准确率标签 |
| review | 分页查询、受限复核接口、超时自动拒绝 | 无人工审核页面、邮件或 webhook 通知 |
| 运营控制 | 服务端禁用检测器、全局 block-all、等价主备路由合同 | 不自建控制面；备用供应商仅在配置后可用 |
| 策略公开 | 从同一生效策略输出 AUP 类别与公开说明 | 不公开阈值、风控特征或受限事件细节 |
| 存储 | 复用现有 SQL/Kysely 真实事务路径，首期生产验收 PostgreSQL，迁移需显式执行 | SQLite 可作逻辑回归，不代表生产并发验收；拒绝内存和顺序执行的伪事务 |
| 清理与回执 | 普通数据到期/删除请求、宿主动作批处理和回执、交付事实回写 | 不自建定时服务；依赖宿主调度及素材清理适配器 |

首期不包含抽帧/转写基础设施、专业人脸或音频识别服务、事实核查检索系统、运营或封号后台、自动训练/调阈值、检测结果缓存、跨请求导出任务系统、自动向外部机构报告、自动替用户开通支付渠道。媒体提取参数、受限事件交接与宿主处置回执接口仍在首期合同内；不为尚未接入的专用服务建设空实现。

“首期能力交付”与“站点可生产放行”分别验收。getCapabilities 必须按工作流、检查点、模态及必需类别返回 readiness 和缺口。仅接 OpenAI 时，若图片/视频工作流的底线要求专用儿童安全或其他未支持能力，该工作流只能隔离/拒绝，不能因接口已支持图片就宣称可完整上线。人工复核不能直接填掉 unsupported；只能补充满足底线的证据或能力后重新评估。

## 3. 检查点与业务流程

| 检查点 | 对象 | 触发条件 |
| --- | --- | --- |
| `prompt` | 提示词、用户指令 | 每次生成尝试之前 |
| `input` | 上传素材、关联上下文和授权凭证 | 上传、替换、进入处理链 |
| `output` | 生成物及其随附文案 | 每次 provider 成功产出后 |
| `presentation` | 标题、描述、alt、公开文件名、分享卡片及组合展示 | 编辑、发布、变更可见范围 |
| `reuse` | 已审核素材与新的使用者、用途及上下文 | 引用、混合、转分享、二次创作 |

正常生成链：`prompt → input → provider → output → presentation → 交付校验`。所需素材尚未齐备时不得预先签发 input 许可。没有素材等不适用情况必须由服务端策略记录 not_applicable 及原因。

prompt 拒绝后不执行 input，不调用 provider，不执行 output；后续阶段记 skipped。input 拒绝同样不调用 provider。生成物先存于私有位置，output/presentation 完成前不可公开。外链、预览、分享图、下载和 CDN 入口均属于交付边界。

attempt 表示一次审核业务尝试，kind 为 generation/publication/reuse。每次生成调用及真正的 provider 重试使用独立 attempt_id；独立编辑发布或二次使用也新建 attempt，关联源决策，不要求伪造 provider 调用或 outcome。job_id 关联宿主任务，同一次网络写入重试使用原幂等键。

首次 evaluate 以 expected_state_revision=0 原子创建 attempt；后续请求按 state_revision 比较更新。每个检查点的内容包及上下文摘要独立记录：生成 output 是该尝试正常增加的新内容，不会使 prompt/input 自身失效；已经评估的内容或上下文被修改，则新建 attempt 并记录源关联，不能覆盖旧尝试。content_revision 指当前检查包的版本，不是所有阶段共享的版本号。当前尝试必须产生自己的阶段决策，不能把源决策直接当作新主体、新上下文的授权。

固定工作流与合法组合如下，其余 stage/operation/kind 组合拒绝：

| attempt kind | evaluate 的 stage / operation | 推进或授权前提 |
| --- | --- | --- |
| generation | prompt/generate、input/generate | prompt 通过只推进至 input；生成授权必须同时满足 prompt 和 input |
| generation | output/publish、presentation/publish | output 通过只推进至 presentation；发布/交付还需 provider 成功、当前输出与展示均通过 |
| publication | input/publish、presentation/publish | 无新生成的上传/编辑发布：当前素材与展示均检查，源材料访问及授权仍有效 |
| reuse | reuse/reuse、presentation/publish | 使用前核查来源权限、新主体、新用途；公开展示还需新 presentation 检查 |

evaluate 只记录检查点结论并返回 continue/deny/quarantine；唯一操作许可入口为 authorizeOperation。generate、publish、reuse、deliver 各自校验上述完整前提；deliver 不通过 evaluate 伪造一个新阶段。缺少素材、无新 provider 等阶段是否不适用必须由对应工作流规则记录，不能由调用方自行跳过。复用后再生成，仍需新的 generation 尝试完成 prompt/input。

回流不是第六个检查点。举报、申诉、复核和 outcome 都追加到事件链。举报可撤回后续交付权限并触发重审；历史许可和实际已交付事实保留。无法收回用户已经下载的副本。

## 4. 检测层与类别

| 层 | 负责内容 | 首期执行方式 |
| --- | --- | --- |
| `rules` | 指定文字、人物/角色名称、禁止的操作表达 | 配置的文字规则 |
| `safety` | 色情、裸露、暴力、血腥、自残、仇恨等 | OpenAI 原生支持部分；其他能力由专用检测器提供 |
| `identity` | 真人脱衣、非自愿裸体、换脸、人脸/声音克隆、冒充、公众人物限制 | 专用检测器和授权证据 |
| `rights` | 版权角色、音乐、影视原片、素材授权 | 专用检测器和授权证据 |
| `security` | 越狱、提示词注入、诱导绕过审核、恐怖主义专项规则 | 文字快筛或专用检测器；规则无命中不算完整语义覆盖 |
| `authenticity` | 虚假新闻、伪造官方信息等 | 需要外部证据的专用检测器 |
| `abuse` | 高频试探、重复边缘命中，以及宿主可提供的注册/设备行为 | 首期内置频次、重复命中、边缘试探；批量注册等需宿主专用规则，不宣称默认覆盖 |

平台类别注册表首期包含：`nudity`、`sexual`、`sexual/minors`、`sexual/fetish`、`sexual/clothed`、`non-consensual-nudity`、`violence`、`violence/graphic`、`self-harm`、`hate`、`harassment`、`terrorism`、`face-swap`、`face-clone`、`voice-clone`、`impersonation`、`public-figure`、`misinformation`、`copyright/character`、`copyright/music`、`copyright/material`、`prompt-injection`。类别注册不等于已具备检测器；额外原生子类别在映射明细中保留。

能力矩阵按 `detector_id × detector_version × modality × category × inspection_scope` 声明支持情况、启用状态及主备路由。`inspection_scope` 区分文字、原图、抽样帧、转写、元数据、声明核验。规则匹配器不声明完整语义能力；不能仅靠其无命中覆盖必需的语义检查。

OpenAI 的 `sexual/minors` 仅支持文本，图片返回零分不构成通过；音频不受该接口直接支持。`sexual` 也不能被直接等同于裸露、非自愿或已获授权。恋物、着衣性化等独立平台类别不得伪装成 provider 原生分类。必需类别没有适用检测器时保持 unsupported，进入 review。

abuse 使用服务端验证的账号、可信代理链得到的 IP、宿主验证的设备引用和支付渠道引用，不收集卡号。普通共享 IP 或单次模型分数不能独立触发永久封禁。标识按租户作带密钥摘要；原始证据如需保留须单独受限。行为结果仅产生 `limit`、`challenge`、`review`，不直接生成内容 hard-block。

请求频次按唯一 attempt 的进入事件计一次，重复命中按唯一逻辑检查计数，网络重试、多个阶段和主备检测不能把同一请求倍增。独立 check 不计为生成尝试，其调用频率由宿主接口限流；更复杂的注册/设备模式缺少可信特征时不声明执行完成。

## 5. 策略与决策合同

平台策略定义必查类别、适用检查点、最低检查范围、规则、超时和 review 截止上限。租户只能增加限制。不同 provider 分数不可直接比较，“更严”通过明确的规则及 provider 专属阈值约束校验，不对所有分数做统一数值比较。

有效策略是不可变快照，包含 `platform_version`、`tenant_version`、`effective_policy_version`、类别映射版本和采样方案。任何影响判断的修改产生新版本。缺少必需配置拒绝启动；运行时能力缺失进入 review，不静默补默认值。

| decision | block_level | 固定执行含义 |
| --- | --- | --- |
| `allow` | null | 本检查点通过，可推进流程；实际操作还须经过 authorizeOperation |
| `review` | null | 暂停该操作，不生成、不发布、不交付；等待受限复核或到期拒绝 |
| `block` | `soft` | 拒绝本次操作，用户可修改后发起新请求 |
| `block` | `hard` | 拒绝并终止本次生成会话；追加账号处置事件 |
| `legal_hold` | null | 受限流程接管，不走普通 review 或普通导出 |

聚合优先级：`legal_hold > hard-block > soft-block > review > allow`。已发生拦截不会因后续错误降为 review。`execution` 为 completed/partial/error，表达执行情况，不替代内容决策。fail-closed 意味着未完成必需检查就不许可，不能把基础设施故障认定为用户内容违法。

| coverage | 含义 |
| --- | --- |
| `checked` | 在明示范围内实际执行完成 |
| `unsupported` | 没有已启用、支持该类别及模态/范围的检测器 |
| `missing` | 缺少必要素材、音轨、授权证明等输入 |
| `skipped` | 因前序拒绝而短路未执行 |
| `failed` | 检测调用失败或返回不满足合同 |
| `not_applicable` | 服务端策略判断不适用，并附规则及原因 |

每项逻辑检查有稳定的 requested_check_id，绑定 item_id/版本/field、modality、category 和 minimum_scope。策略生成必需项，不接受 detector 自行缩减。检测尝试的 Finding 与逻辑检查的 CheckCoverage 分开保存：主检测技术失败但合格备用完成，可使该逻辑检查最终为 checked，同时保留主失败证据；范围不足的转写不能补足原图/视频帧检查。任一实质拦截仍优先，不能被备用通过覆盖。

只有必需逻辑检查均满足覆盖要求，且无拒绝、无待复核条件，才能产生 allow；决策依据聚合后的 CheckCoverage，不把已由备用解决的单次失败重复作为未完成项。execution 在仍有未解决故障时为 partial/error；主失败已被完整补足时可为 completed，故障历史不删除。不存在评分的规则，其 score、threshold 为 null，不制造置信度。分数来源、单位和原生类别必须一起记录；多级阈值及命中动作的完整定义保存在策略快照。

未成年性化的明确命中执行平台强制拦截并产生受限账号处置动作，不能按普通软拦截修改原决策放行；模型疑似或年龄估计不直接等于永久封禁事实。账号处罚由固定规则及累计事件决定，误判更正必须追加受限复核记录。

已知或疑似真实 CSAM 材料在进入通用检测器前交专门入口处理；不能仅凭普通 `sexual/minors` 文字标记把请求认定为真实 CSAM。legal_hold 的材料、详细类别和处置记录不进入普通日志、普通 review 队列或前端，不允许普通人工放行。通用服务只持有不含材料的受限引用；专用留存、访问和报告流程另行确定，不由常规清理任务销毁。

## 6. 拟定接口

以下为设计阶段的 TypeScript 逻辑合同；实际入参必填项、命名和类型以导出源码及接入说明为准。时间用 UTC ISO 8601；时长用毫秒；ID 为不透明字符串。租户、主体、操作者和权限来自宿主已验证上下文，不接受浏览器自报权限。

```ts
type Stage = "prompt" | "input" | "output" | "presentation" | "reuse";
type Operation = "generate" | "publish" | "reuse" | "deliver";
type Layer = "rules" | "safety" | "identity" | "rights"
  | "security" | "authenticity" | "abuse";
type Coverage = "checked" | "unsupported" | "missing"
  | "skipped" | "failed" | "not_applicable";
type Decision = "allow" | "review" | "block" | "legal_hold";
type AttemptKind = "generation" | "publication" | "reuse";

interface TrustedContext {
  tenant_id: string;
  subject_id: string;
  actor_id: string;
  // 权限由宿主认证桥接检查，不以这些 ID 的存在证明授权。
}

interface ResolvedAbuseContext {
  account_ref: string;
  ip_digest: string | null;
  device_ref: string | null;
  payment_ref: string | null;
  source_version: string;
  observed_at: string;
}

type ContentItem = {
  item_id: string;
  field: "prompt" | "media" | "title" | "description"
    | "alt" | "filename" | "share_copy";
  revision: string;
} & (
  | { modality: "text"; text: string }
  | { modality: "image" | "audio" | "video"; asset_ref: string }
);

interface CheckRequest {
  context: TrustedContext;
  job_id: string | null;
  attempt_id: string | null;
  stage: Stage;
  layers: Layer[];
  categories: string[];
  items: ContentItem[];
  content_revision: string;
  context_digest: string;
  idempotency_key: string;
}

interface EvaluationRequest {
  context: TrustedContext;
  job_id: string;
  attempt_id: string;
  attempt_kind: AttemptKind;
  stage: Stage;
  operation: Operation;
  items: ContentItem[];
  content_revision: string;
  context_digest: string;
  consent_ids: string[];
  source_decision_ids: string[];
  expected_state_revision: number;
  idempotency_key: string;
  // 必需类别、检测层及前序决策由服务端策略和持久化状态补齐。
}

interface Finding {
  finding_id: string;
  requested_check_id: string;
  item_id: string;
  modality: "text" | "image" | "audio" | "video";
  category: string;
  inspection_scope: string;
  coverage: Coverage;
  mode: "enforce" | "shadow";
  decision: Decision | null;
  block_level: "soft" | "hard" | null;
  detector_id: string | null;
  detector_version: string | null;
  provider_model: string | null;
  provider_request_id: string | null;
  native_category: string | null;
  native_flagged: boolean | null;
  score: number | null;
  threshold: number | null;
  rule_id: string | null;
  reason_code: string;
}

interface CheckCoverage {
  requested_check_id: string;
  item_id: string;
  category: string;
  modality: "text" | "image" | "audio" | "video";
  minimum_scope: string;
  required: boolean;
  mode: "enforce" | "shadow";
  coverage: Coverage;
  finding_ids: string[];
  reason_code: string;
}

interface AbuseFinding {
  rule_id: string;
  subject_ref: string;
  window_start: string;
  window_end: string;
  coverage: Coverage;
  observed_count: number | null;
  threshold: number | null;
  effect: "none" | "limit" | "challenge" | "review";
  // 具体额度、验证种类等参数由该 rule_id 对应的策略快照定义。
  evidence_event_ids: string[];
  mode: "enforce" | "shadow";
  reason_code: string;
}

interface ModerationDecision {
  decision_id: string;
  tenant_id: string;
  subject_id: string;
  job_id: string;
  attempt_id: string;
  stage: Stage;
  operation: Operation;
  content_revision: string;
  context_digest: string;
  policy_version: string;
  capability_snapshot_id: string;
  decision: Decision;
  block_level: "soft" | "hard" | null;
  execution: "completed" | "partial" | "error";
  enforcement: "continue" | "deny" | "quarantine";
  findings: Finding[];
  check_coverage: CheckCoverage[];
  abuse_findings: AbuseFinding[];
  prerequisite_decision_ids: string[];
  action_ids: string[];
  mode: "enforce" | "shadow";
  would_decision: Decision;
  would_block_level: "soft" | "hard" | null;
  would_action_types: string[];
  supersedes_decision_id: string | null;
  created_at: string;
  expires_at: string | null;
}

interface OperationAuthorization {
  authorization_id: string | null;
  attempt_id: string;
  operation: Operation;
  permit: boolean;
  decision_ids: string[];
  reason_code: string;
  expires_at: string | null;
}

interface EvaluationResult {
  decision: ModerationDecision;
  state_revision: number;
}
```

`createModeration(options)` 必需策略/控制状态解析器、检测器注册表和持久化适配器；媒体解析、受限交接及账号动作适配器按启用能力接入，不为构造纯文本服务强制配置全部外部系统。相关能力被要求但缺少适配器时 fail-closed。网络、超时、截止时间、额度、保留期限由服务端配置/版本化策略提供；密钥不进入快照或证据。

`resolveAbuseContext(context, attempt_id, signal)` 返回 ResolvedAbuseContext。账号引用来自已验证主体，IP/设备/支付引用仅在宿主已验证并提供时使用，缺失为 null，不采信浏览器自报身份。abuse 接收这些引用及共享存储的行为窗口，返回独立 AbuseFinding，而不是绑定某张图片的内容 Finding。缺少规则必需信号记 missing；challenge 或必需动作未完成时 review+deny，limit 只有执行成功且请求仍在有效额度内才能推进。

独立 check 可以令 job_id/attempt_id 同时为 null；关联现有尝试时二者必须匹配已持久化主体。局部报告仅作诊断与证据，不在首期被 evaluate 当作免检凭证。content_revision 和 context_digest 由宿主服务端对规范化字段、不可变素材版本、用途、可见范围及主体生成并核对；不信任浏览器提供的摘要或指向可变内容的 asset_ref。

| 方法 | 入参核心字段 | 返回与约束 |
| --- | --- | --- |
| `check(request, signal?)` | CheckRequest | 持久化局部 CheckReport：报告 ID、版本、findings、check_coverage、abuse_findings、execution；永不返回 permit |
| `evaluate(request, signal?)` | EvaluationRequest | EvaluationResult：内部决策及本次提交后的 state_revision；验证前序阶段、租户、主体、版本和底线 |
| `authorizeOperation(request)` | 可信上下文、attempt_id、operation、目标素材/展示版本、幂等键 | 返回 OperationAuthorization；重读完整前提、当前策略/控制状态、撤回、期限和必需动作，不信任外传 allow；仅成功时有授权 ID 和期限 |
| `recordProviderResult(event)` | event_id、attempt_id、status、provider/request/model、错误或拒绝代码 | 幂等追加事实；status 为 succeeded/policy_refused/technical_error |
| `recordOutcome(event)` | event_id、attempt_id、outcome、provider_event_id、decision_id | 按第 7 节校验并写入；相同事件重试不重复统计 |
| `recordDelivery(event)` | 可信上下文、event_id、attempt_id、decision_id、authorization_id（可空）、实际版本、released/withheld/revoked、occurred_at | 记录已观察事实；违背授权也保留并追加 anomaly，不丢弃违规交付记录 |
| `recordFeedback(event)` | 可信操作者、event_id、目标 decision_id、report/appeal、原因、受限证据引用 | 写事件并按策略撤回后续许可；不接收用户上传的“最终结论” |
| `listReviews(query)` | 经授权的租户、游标、受限页大小 | 分页当前待复核项，不含 legal_hold 材料 |
| `resolveReview(command)` | 有复核权限的操作者、event_id、expected_decision_id、reason_code、完整 evaluation | 重新运行检测，返回 EvaluationResult，追加复核事件和替代决策；并发冲突拒绝；不能直接指定 allow、豁免平台底线或 legal_hold |
| `expireReviews(command)` | 可信 Worker 上下文、游标、受限批大小 | 到期追加 soft-block/review_timeout；交付检查自行判定到期，不依赖 Worker 准点 |
| `runPendingActions(command)` | 可信 Worker 上下文、受限批大小 | 原子领取有限租约，调用宿主 execute(action_id, payload)，幂等写回 succeeded/failed/pending 及原因；仅 succeeded 表示处置条件已完成 |
| `recordConsent(command)` | 可信上下文、event_id、素材摘要、声明版本、用途、期限、证明引用 | 创建 declared 声明并返回不可变 consent_id，不接受上传者直接指定 verified |
| `verifyConsent(command)` | 有核验权限的操作者、event_id、consent_id、expected_consent_revision、证据引用、核验方式、结论、用途及期限 | 给原声明追加 verified/rejected/insufficient 事件；保留关联、来源及操作者，不能用新建 verified 声明替代核验 |
| `revokeConsent(command)` | event_id、consent_id、操作者及原因 | 追加撤回事件并使相关后续许可失效 |
| `cleanupData(command)` | 有删除权限的上下文或可信 Worker、cleanup_id、批次幂等键、删除主体/到期范围、受限批大小、游标 | 依策略分批清理、调用宿主 erase(cleanup_id, ref) 并留回执，返回 completed/partial/failed、下一批游标及受限例外，不冒充已完成外部删除 |
| `getCapabilities(query)` | context、可选 attempt_kind/stage/modality | 当前矩阵、启用状态、检查范围、readiness 与缺口；不声称未接入能力可用 |
| `getPublicPolicy(query)` | 已验证 context | 生效策略版本、公开类别及 AUP 说明，无阈值和风控特征；语言由配置的公开说明选择 |
| `exportEvidence(query)` | 有导出权限的 context、from、to | 单请求有界一致性快照内输出脱敏 JSONL 字符串及摘要；超限拆分窗口，服务端生成审计 ID，重试是新快照，不保证相同文件或跨请求续传 |

可选 `moderation(options)` 桥接到同一服务；Better Auth 提供 `auth.api.moderateContent()` 对应 evaluate、`auth.api.authorizeModerationOperation()` 对应授权。其余生命周期通过独立模块和共享存储使用。桥接方法为 serverOnly，不自动挂公共 HTTP 接口。宿主显式开放举报/声明路由时负责会话、CSRF、限流和所有权校验。公开 AUP 只使用公开投影。

内部 ModerationDecision 不能直接 JSON 返回浏览器。另行生成公开拒绝响应，只含通用状态、可公开原因及不透明查询引用，不暴露 score、threshold、处罚特征或 legal_hold 类型。

输入边界必须校验注册类别、合法工作流组合、字段/模态、素材所有权、规范化摘要、ID 关联及策略规定的项数/文字/媒体上限。未知类别是无效请求；已注册但没有检测能力才是 unsupported。空 items 只允许工作流明确无素材的 input，并写阶段不适用事件，不伪造某个素材已检查。授权只绑定指定尝试、操作及版本；仅 permit=true 时返回非空 authorization_id 和有限期限，写授权事件后立即供宿主执行，不承诺跨系统 exactly-once。实际生成/发布仍由宿主携带稳定业务键防重复，不能循环重放同一许可；授权后发生的 kill switch 不保证取消已经在执行的上游调用，后续交付仍须重查。

state_revision 是当前尝试投影版本，放在 EvaluationResult，不写成不可变内容判断的属性。STATE_CONFLICT 返回受权上下文可见的 current_state_revision 和 current_decision_ids，调用方核对后以新命令重试，不能猜自增值。authorizeOperation 发现策略/能力版本或前提已经失效，返回拒绝及重新评估原因，不自行把旧评分套上新策略放行。

### 检测器与媒体合同

`ModerationDetector` 声明 id、适配器版本、layer、支持的类别/模态/检查范围；`check({ items, requested_checks, signal })` 对每项请求返回 DetectorFinding，编排器绑定规则及版本生成 Finding。requested_checks 只携带该检测器需要的 rule，不传完整策略、供应商密钥或其他租户信息。abuse 独立接收 ResolvedAbuseContext、规则及行为窗口，返回 AbuseFinding[]。必须显式返回不支持项；缺项、重复、未知类别或格式异常作为 failed，不可默认通过。required 与 minimum_scope 由编排层生成，不能由 detector 自报为更小范围。保留 provider 返回的模型标识；未获得时明确 null。

受限前置适配器 `resolveRestrictedSignal(context, items, signal)` 接收可信、绑定素材版本的已知/疑似信号，返回 none/suspected/confirmed、来源及受限证据引用；在 check/evaluate 的所有通用检测调用之前执行。suspected/confirmed 立即停止普通检测和内容复制，调用幂等 handoff，成功后普通库只存 case_ref 的最小 legal_hold 投影。交接失败时仍拒绝，并仅记不含材料的故障，不声称交接已完成。none 只是没有已知信号，不代表 CSAM 检测通过；必需专用能力缺失仍 unsupported。没有受限交接服务也不得把疑似材料转送 OpenAI。

媒体解析器以私有 `asset_ref` 为主。外部 URL 先经宿主受控获取转成私有引用，不能原样交给任意 detector 抓取。视频参数和实际结果均写入证据：

```ts
interface VideoInspectionPlan {
  version: string;
  frames_per_second: number;
  include_first_frame: boolean;
  include_last_frame: boolean;
  sample_scene_changes: boolean;
  include_audio: boolean;
  max_duration_ms: number;
  max_frames: number;
}

interface VideoInspectionManifest {
  plan_version: string;
  extractor_version: string;
  asset_revision: string;
  actual_duration_ms: number;
  frames: { timestamp_ms: number; asset_ref: string }[];
  audio: { status: Coverage; transcript_ref: string | null };
  unmet_requirements: string[];
}
```

参数须在策略规定的上下界内，不能为逃避审核把采样率或最大帧数设为无效值。截断、超长、不能按场景采样、音轨缺失均报告实际缺口。转写只覆盖言语文字，不覆盖声音克隆或音乐版权。manifest 及其所有必需帧/音轨均绑定逻辑检查；不能只检查其中一帧就把整个抽样方案记 checked，任一命中仍拦截。抽样帧通过不表示完整视频逐帧通过；未达到策略最低范围时进入 review。

## 7. outcome、复核与账号动作

| outcome | 写入前提 |
| --- | --- |
| `accepted` | provider 成功产出，所需 output/presentation 检查最终允许交付 |
| `refused` | 有 provider 明确政策拒绝证据；超时、限流和 5xx 均不满足 |
| `output_blocked` | provider 已成功产出，但站点输出或首次展示审核最终拒绝交付 |

prompt/input 拦截、技术错误及 pending review 不强填 outcome；publication/reuse 尝试不写生成 outcome。`accepted` 表示允许交付，不代表实际下载成功；交付另记 released/withheld/revoked 事件。released 定义为已向用户签发可用访问凭证或公开可访问，不推断用户完整下载。单个 generation attempt 最多有一个最终 outcome；审核重开通过关联新事件和新决策表达，不覆盖原 outcome。

provider_status、site_decision、实际交付状态分别保存。发现“provider 拒绝但已经交付”等矛盾时写 audit_anomaly 并阻止新的许可，不修改其中一侧来消除矛盾。recordOutcome 的非法转换被拒绝并留下脱敏异常事件；数据管道仍需保留观察到的实际交付事实。

review 自创建时记录截止时间；到期固定拒绝，不因无人处理无限等待。普通复核可补充证据并更正误判，但不能绕过平台强制规则，也不能处理 legal_hold。新策略、新证据或新上下文需要新评估，不能直接改 findings。

hard-block 的生成会话终止和账号处罚分开记录。账号处罚动作包含 action_id、规则版本、原因、目标及 pending/succeeded/failed 回执；宿主通过幂等适配器执行限额、验证、会话撤销或封禁。未成功的必需动作保持后续许可关闭，不能把 banRequired 等同于“已封禁”。abuse 产生的动作不伪装成内容违规结论。

runPendingActions 由宿主定时器、队列或 Worker 调用，每次只处理受限一批，SDK 不自动启动循环。领取使用租约和原子比较更新，按策略限定重试次数、间隔及截止时间；崩溃后可由其他实例接管，execute 必须按 action_id 防重复。challenge 已发出但未验证只能返回 pending，重试查询同一动作状态，不能重复发起验证或提前记 succeeded。账号动作失败不隐藏，相关必需条件保持关闭。

动作完成不直接改写原 review 或自动签发许可。宿主在 review 截止时间内，以当前 state_revision 和新幂等键对同一内容包重新 evaluate，复用已成功 action_id/可信验证事实，追加 supersedes 的新决策后再授权；不能重新创建同一 challenge。超时后需新尝试；内容、主体或用途变化也需新尝试。该路径不解除强制内容拦截或 legal_hold。

## 8. 逻辑数据结构与一致性

以下为逻辑记录，首期映射到独立审核模块的 moderationRecord 类型记录；不是独立专表迁移 SQL。所有普通记录均有 tenant_id，关联校验及唯一约束包含租户，禁止仅按客户端提供的全局 ID 查询。

| 记录 | 关键字段 | 写入方式与约束 |
| --- | --- | --- |
| PolicySnapshot | tenant_id、effective_policy_version、platform/tenant_version、snapshot、mapping_version、digest、created_at | 不可变；唯一 tenant_id + effective_policy_version；不保存密钥 |
| CapabilitySnapshot | capability_snapshot_id、tenant_id、矩阵、检测器版本/启停状态、主备路由、控制配置版本、digest、created_at | 不可变；运行配置变更生成新快照，保存当时覆盖能力及路由，不保存凭据 |
| ModerationAttempt | tenant_id、attempt_id、kind、job_id、subject_id、源决策引用、各阶段内容/上下文版本及当前决策、state_revision、review_deadline、delivery_epoch | 当前状态投影；首次 evaluate 创建，CAS 更新，不作为历史事实的替代 |
| CheckReport | report_id、租户/主体/stage、job/attempt（可空）、请求范围、策略/检测版本、capability_snapshot_id、findings、check_coverage、abuse_findings、execution、时间 | 不可变局部报告；不得包含 permit |
| ModerationDecision | 第 6 节字段，以及有效策略/能力快照引用和输入摘要 | 不可变；findings 可用子记录或受校验 JSON 保存；legal_hold 的普通投影仅留通用原因与受限引用，敏感 findings 保存在专用出口 |
| ModerationEvent | event_id、tenant_id、job/attempt/decision_id（按事件可空）、type、actor_id、幂等域、payload_digest、脱敏 payload、occurred_at、recorded_at | 追加；包含执行开始/结束、授权、provider、outcome、举报、申诉、复核、交付、异常、清理回执和导出；隐私清理不改变历史结论 |
| ConsentDeclaration | consent_id、tenant_id、subject/actor_id、素材摘要、声明/证明引用、用途、期限、声明版本、核验来源、时间 | 声明不可变；撤回及后续核验追加事件，当前效力从事件投影 |
| AbuseBucket | tenant_id、标识类型及带密钥摘要、窗口起止、规则版本、计数/边缘命中 | 共享存储原子更新；按事件去重，重试不增加计数；按策略过期 |
| EnforcementAction | action_id、tenant_id、subject_id、源决策/事件、规则版本、类型、状态、回执及重试信息 | 动作意图与决策同事务；执行回执追加事件，状态投影幂等更新 |
| RestrictedCaseRef | 不透明 case_ref、受限系统引用、受控状态 | 独立存储/权限出口；普通库只留最小引用，不含敏感材料 |

普通记录使用服务端生成的不透明 ID。写操作的幂等域为 tenant_id + 方法/事件类型 + idempotency_key/event_id；先检查幂等记录，再作版本比较。同键同载荷返回原写入结果，同键不同载荷报冲突，不覆盖旧数据。授权是例外：幂等键只防重复签发和计数，每次仍重读当前控制/撤回状态，不能重放旧 permit；状态失效返回 deny 并追加检查事件。主体、素材和决策引用必须同租户，并校验当前操作者权限。

检测前先用唯一幂等域保留执行标识，检测在事务外运行；同键执行中返回可重试 IN_PROGRESS，不启动第二次外部调用。结果提交时再比较状态版本，冲突可保留诊断报告但不得挂到错误的当前状态。中断执行标识须受超时/接管规则约束，不能永久卡住；超时不代表供应商必定未执行。

持久化适配器必须支持：

- 原子提交策略/能力快照引用、决策及 findings、必要事件、账号动作意图和当前状态投影；被引用快照须已持久化，成功前不签发许可。
- expected_state_revision / expected_decision_id 的比较更新；并发复核或上下文改变返回冲突。
- 共享行为计数原子更新和事件去重；分页查询、按截止时间扫描、固定截点的证据导出。
- 受策略约束的清理及脱敏删除事件；删除不能静默改写历史结论。

写入失败可能发生在已提交但响应丢失之后，调用方必须用原幂等键重查/重试，不能换键制造第二次处置。数据库不可用、受限交接失败或必需处置失败时拒绝当前操作；不声称已经创建了持久 review 任务。

首期索引目标：租户+attempt、租户+job、租户+主体+时间、租户+review_deadline、租户+策略版本+时间、事件唯一键、outcome 的 attempt 唯一约束、行为窗口唯一键。外部副作用在事务提交后由宿主 Worker 执行并记录回执，不在数据库事务中等待供应商网络调用。

首个生产适配目标为 PostgreSQL，复用仓库现有 Kysely/SQL 真事务、条件写入和唯一索引能力，不新增通用数据库框架。Better Auth DBAdapter 即使有 transaction 方法也可能顺序执行；必须核验适配器真实事务配置并用回滚、唯一冲突和并发条件更新用例验收，不能只检查方法存在。独立 createModeration 注入同一审核存储实现，桥接插件复用认证实例；不存在隐含的多租户认证系统或自带通用 Worker。

## 9. 故障、缓存与控制

主检测器技术失败可走已配置、类别/模态/范围等价的备用路由，完整记录两次尝试。主检测器的政策拒绝不能由备用 allow 覆盖。没有合格备用时保留 failed，执行本地可用规则后聚合为 review；如果规则已拦截则保留 block。

禁用检测器和 block-all 仅由受权服务端控制。每次 evaluate/authorizeOperation 从宿主权威控制存储读取控制版本，读取失败拒绝，不依赖浏览器或某个实例启动时的环境快照。禁用某检测器不删除平台必查项；无替代覆盖则 review。block-all 在生成及交付入口均检查，优先于旧许可；启停留审计事件。首期不自建控制页面或分布式配置平台。

首期不实现检测结果缓存，重复的新尝试重新检测；普通幂等重试返回已写入结果不等于跨尝试缓存。为后续实现保留边界：仅同租户、同主体可复用；键须包含内容/上下文版本、操作/检查点、effective_policy_version、类别/范围、检测器/映射版本、采样方案、授权效力及风险/交付 epoch。期限受策略限制，举报、授权撤回、处罚、策略变更和 kill switch 必须使旧许可失效。

供应商内部模型版本未知时不可宣称可精确重现；仍记录返回标识、适配器版本、请求 ID 和执行时间。即使以后加入缓存，也必须生成新尝试自己的可追溯决策引用并重新作操作授权，不把局部缓存报告当全链路许可。

## 10. 交付、隐私、AUP 与证据导出

外部素材获取须校验协议、解析后的地址和每次重定向，阻止内网/本机/元数据地址访问，限制体积、时长、解压及读取时间，并验证实际内容类型。不得把带凭据 URL、完整提示词或素材原文写普通日志。私有引用及证明材料均受所有权和用途限制。

交付前清理 EXIF 等非必要元数据，再核对实际交付版本的审核状态；转换若改变可感知内容需重审。短时签名链接只在 authorizeOperation(deliver) 通过后签发。普通对象存储签名链接通常不能即时撤销：首期只能承诺停止签发并限制剩余有效期；要求即时撤回的站点必须使用每次请求校验当前状态的交付代理。该差异必须出现在宿主接入说明中。

原始素材、普通决策/事件、授权证明、行为标识和受限事件分别配置保留期限及访问范围。删除请求清理可删内容并追加脱敏删除事件；不可把“历史不可变”当作无限保留个人信息的理由。受限材料走独立处置规范，不流入普通备份、导出或自动清理。日志、查询和导出复用既有权限并记录操作审计。

cleanupData 是首期唯一普通清理入口，宿主定时调用处理到期范围，受权删除请求处理指定主体；先撤回相关许可，再分批清除普通个人 payload/关联标识、授权证明、行为摘要和对象引用，并调用宿主 erase 清理私有素材。历史不可变约束禁止篡改判断，不禁止依策略删除个人数据；只保留允许留存的非个人统计、策略版本及脱敏删除回执，不能保留可回推出已删原文的摘要。

cleanup_id 固定整次清理范围，每批有独立幂等键：同批重试返回原批回执，继续下一批使用返回游标和新批次键，不能用同一键改变游标。宿主 erase 按 cleanup_id+资源引用去重，失败项保留在待处理范围，不因游标前进被遗漏。外部清理未完成返回 partial/failed，受限留存例外单独列明，不能谎报全删。宿主负责备份到期和已导出副本的保管/删除；首期不持久化导出文件，不建设额外清理平台。

getPublicPolicy 从同一生效快照输出类别代码、公开说明、禁止用途和政策版本，用于渲染 AUP。规则尚无检测器时，AUP 仍表达禁止政策，能力矩阵明确缺口并 fail-closed；不得宣传已经完整检测。

exportEvidence 采用脱敏 JSONL 及统计摘要，默认排除原始媒体、原文、完整 IP、密钥、凭据链接和受限材料。包含政策/AUP 版本、当时能力矩阵与覆盖缺口、按期间/租户/版本聚合的统计，以及可关联的决策、provider、outcome 和处置回执样本。统计和记录使用同一受限数据库一致性快照，限制窗口、行数及执行时间；超限要求拆分，不保持跨请求长事务或后台导出任务。记录导出截点与统计窗口，未知值显式为 null，不用零填充。

统计口径：按唯一 generation attempt 统计原始 outcome，publication/reuse 单列，不伪造生成次数；按唯一阶段决策统计检查点，按逻辑 requested_check 统计覆盖而不重复计主备调用。各自注明分母，单一 attempt 的阶段拦截不能被当作多个生成任务。每份导出分别列出原始 outcome、截至导出截点的当前有效决策及实际交付状态；首次 output_blocked 后申诉更正并交付的，保留原始拦截计数，同时在当前决策和交付统计中体现更正，不能称其仍被最终拦截。初判拦截率与当前拒绝率分别命名并注明分母。另列 review、错误和 unsupported，不把中断请求从分母中静默删除。误杀/漏检评估需要覆盖放行及拒绝两侧的人工标注样本，provider refusal 只作为对照信号。

宿主可用 blocked 任务行记录 decision_id、类别和生成调用次数，默认不出现在用户历史页。预检查拦截不发生生成调用，不扣生成额度；规则及审核自身成本仍如实记录。输出拦截已经产生的 provider 成本照实保存，是否退还用户额度由业务策略决定，不修改 Business 账本历史或统一标为零成本。

## 11. 验收与上线顺序

本节为后续实现验收目标，本次未执行或宣称通过。

1. 五个检查点可关联同一任务；标题、alt 等编辑及跨用户复用触发新评估，旧许可不能授权新版本。
2. check/evaluate 均不签发操作许可；authorizeOperation 仅在合法工作流完整前提满足后签发。prompt 通过不能绕过 input；首次创建、非生成发布/复用、跨租户/主体访问、伪造 allow、删除必查类别及并发旧版本更新均有验证。
3. 图片 sexual/minors、缺少必要音轨、未接入版权检测器分别体现真实 coverage；规则无命中不能补足语义缺口。
4. prompt/input 拦截后 provider 调用次数为零；输出隔离至审核完成；普通前端不获得 legal_hold 详情或材料。
5. 合格备用可补足主技术失败且保留两侧证据；最低范围不符、未解决技术故障、畸形返回、写库失败、交接/处罚失败均不产生许可，已有 block 不被错误降级。可信受限信号先于所有通用检测处理。
6. 幂等回写、唯一 outcome、provider 拒绝与技术失败区分正确；矛盾交付保留异常，历史不覆盖。
7. review 到期即不可交付，即使 Worker 暂停；复核、授权撤回、举报、block-all 和策略变更使后续许可失效。
8. 首期无结果缓存；幂等重试不重启外部检测或重复处置，授权重试仍检查当前状态；签名 URL 残余有效期如实说明。
9. abuse 原子计数、事件去重、限额/验证/review 与账号处罚回执可审计；不把单次模型分数当永久封号事实。
10. AUP 与生效策略一致；导出分母、主备去重、缺失值、脱敏、权限、版本、成本及删除回执正确，受限材料不混出；真实 SQL 事务回滚与并发冲突经过验证。
11. 后续实现按 AGENTS.md 使用 pnpm；执行定向 SDK 测试、pnpm test:sdk、pnpm typecheck、pnpm build:sdk 和 pnpm test:packaging，记录实际结果。真实服务联调另列，不把模拟合同测试当作供应商准确率验证。

先用标注样本和合同测试验证，再按租户观察一周。shadow mode 只观察待校准的附加规则；平台底线、provider 政策拒绝、受限事件、必需覆盖缺失仍执行拒绝。would_decision/would_block_level/would_action_types 描述若全部启用会怎样；实际 decision/block_level/enforcement/action_ids 只包含 enforce 规则的效果。shadow 附加规则不得真正处罚、扣额、触发验证或阻止交付；基线规则的必需动作照常执行。findings/abuse_findings 标明 mode，不能把观察命中计入实际违规处罚次数，也不能为收集样本公开不应交付的内容。

上线不以“一周结束”自动切换。先确定带版本的采样/标注方案、覆盖及误判验收标准；满足后由受权服务端逐步启用附加拦截，保留版本回滚和 block-all。不同 provider、模态、类别的阈值分别校准，不照搬社区个案的 0.8/0.9。

## 12. 参考与证据边界

- [OpenAI Moderation](https://developers.openai.com/api/docs/guides/moderation)：文本/图片能力、类别及模态限制；分数会随模型变化，阈值需校准。资料核对日期：2026-10-20。
- [OpenAI CSAM guidance](https://developers.openai.com/api/docs/guides/csam-guidance)：专用检测、事件追踪及受限响应流程；通用 Moderation 不能替代专用 CSAM 检测。本文不制定具体司法辖区的留存或报告义务。
- [社区：NSFW 检测机制](https://new.web.cafe/topic/j9va5a0or1)、[社区：输入输出审核讨论](https://new.web.cafe/tutorial/detail/aeckx23bjb)：用户提供的设计背景。公开页未提供正文，个案数字、罚款和渠道拒审说法未独立核实，不作为默认阈值、供应商能力或支付准入承诺。

后续实现前还需提供实际平台底线配置、各租户启用能力、数值阈值/超时/保留期限、专用服务商与受限事件处理方、宿主素材/交付及账号动作适配器。这些是部署和验收输入，不影响先固定本文接口；缺少必需输入时不得以静默放行上线。
