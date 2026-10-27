# SDK 0.4.0

新增服务端 `@app/auth-sdk/media-engine`：应用身份、授权模板、按用户上传/素材/任务、取消、管理访问、原始字节 Webhook 验签。客户端不执行供应商任务、不搬运媒体、不自动重提付费请求。

Webhook 支持显式到期的旧密钥重叠验证，普通配置仍为单个字符串；站点可在原密钥字段使用 JSON keyring，不新增必填环境变量。过期旧密钥拒绝，outbox 原事件重投仍使用当前签名密钥。

原生 `@app/credits` 升级为 0.2.0，新增永久积分 `reserve`、`settle`、`release`、`reservation`、`account` 与 `withCreditsTransaction`。冻结快照与批次仍在追加账本；结算只写一次消费，释放不赠送积分。`balance()` 现在表达可用余额；没有冻结的旧账户结果保持一致。宿主先补齐 `creditEntry.holdState`、`reservationId` 与原唯一索引，再启用冻结；不能覆写历史流水。

`verifyMediaEngineNotification` 验证生成事件与 `moderation.action` 联合类型；原 `verifyMediaEngineEvent` 保留生成事件合同。宿主将 `mediaEngineActionReceiptSchema` 注册到原 SQL 适配器后，在本地 inbox 事务内调用 `applyMediaEngineAction`。支持 ban / revoke_session，管理员账号需人工处理；limit / challenge 显式失败。重复事件复用不可变回执，不会再次封禁已经人工解封的用户。

审核核心修复计数窗口切换时丢失原任务动作约束的问题：同一任务/策略已产生的动作继续要求全部有效回执，不因新的计数窗口自动放行；包含固定时钟、两种规则顺序的回归。

认证、支付、i18n、旧生成及审核导出保留。Engine 和 aimeme 分别固定安装 0.4.0 审核核心与客户端；历史 0.3.0 包不覆写。旧能力退出条件与消费者清单见 Engine 的迁移验收记录，不对未登记消费者做破坏性删除。

完整事务、签名与管理访问合同见 [中台接入](media-engine-usage.md)。验证使用真实 SQL 与外部服务测试边界；不代表真实 KIE / SeeAPI / R2 或生产发布已验收。
