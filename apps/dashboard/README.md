# Dashboard

基于用户提供的 `D:/codes/SEO/模板/Dashboard-finance-tracker` 复制后裁剪，原模板未修改。保留模板的排版、配色、主题切换、横向 Tabs、图表和弹窗过渡动效，改为连接本仓库真实 SDK 的独立后台。首页风格不必与后台一致。

包含概览、用户与会话、商品套餐、订单与履约重试、付款统计与累计消费、会员、积分流水与人工调整、操作记录、监控及工单。移除原来的个人财务假数据、收支/储蓄/贷款/目标演示、追踪脚本及不使用的界面组件。生产界面不以演示数据替代接口失败。

新增用户反馈工单：用户在 `/support` 提交、查看自己的反馈和追加回复；管理员在“工单”页签查看全部反馈、回复、修改状态。网站与后台共用现有认证实例和数据库。

## 本地启动

需要支持 `--experimental-strip-types` 的 Node.js（建议 Node 22.18+）与 pnpm。在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm build:sdk
Copy-Item apps/dashboard/.env.example apps/dashboard/.env.local
```

填写 `apps/dashboard/.env.local`：

| 环境变量 | 用途 |
| --- | --- |
| `BETTER_AUTH_URL` | 网站完整来源，开发使用 `http://127.0.0.1:3001`，与启动脚本一致；不包含路径、查询或用户凭证 |
| `BETTER_AUTH_SECRET` | 独立随机密钥，至少 32 字符；示例留空，未填写无法启动认证 |
| `DATABASE_URL` | PostgreSQL 连接串；生产必须配置此项 |
| `DASHBOARD_SQLITE_PATH` | 显式选择本地 SQLite 文件，模板为 `.data/dashboard.sqlite`；与 `DATABASE_URL` 二选一 |
| `DASHBOARD_ADMIN_EMAIL` | 初始化时新建管理员邮箱 |
| `DASHBOARD_ADMIN_PASSWORD` | 初始化密码，12–128 字符；不要提交到版本库 |
| `DASHBOARD_ADMIN_NAME` | 管理员显示名，默认 `Administrator` |

然后执行：

```powershell
pnpm dashboard:setup
pnpm dashboard:dev
```

访问 `http://127.0.0.1:3001`，使用初始化时设置的凭据登录。已配置邮件时，未验证邮箱的管理员也需要先完成邮件验证；初始化不会自动将邮箱标记为已验证。`BETTER_AUTH_URL` 与浏览器访问地址应保持一致，不要混用 `localhost` 与 `127.0.0.1`。初始化完成后从 `.env.local` 移除 `DASHBOARD_ADMIN_PASSWORD`；运行应用无需保留初始化凭据。

本地 SQLite 文件路径相对于后台工作目录 `apps/dashboard`。应用使用真实持久化 SQLite，不是内存演示库；`NODE_ENV=production` 明确禁止 SQLite，生产配置 PostgreSQL。本地未配置邮件时关闭邮箱公开注册；配置完整后启用邮箱注册和验证。可选 Google 登录允许创建普通网站用户。应用不会自动创建管理员、迁移数据库或发放测试积分。

## 注册邮件与密码重置

使用通用 SMTP，可接入现有邮箱服务，不需要第三方登录配置：

| 环境变量 | 用途 |
| --- | --- |
| `SMTP_HOST` | SMTP 主机名，不包含协议或端口 |
| `SMTP_PORT` | 默认 `587`；按邮件服务要求填写 |
| `SMTP_SECURE` | `false` 使用 STARTTLS，通常配合 `587`；`true` 使用隐式 TLS，`465` 必须为 `true` |
| `SMTP_USER` | SMTP 登录账号 |
| `SMTP_PASSWORD` | SMTP 密码或邮件服务生成的授权码 |
| `EMAIL_FROM` | 服务商允许的发件地址，如 `App <noreply@example.com>` |

生产环境必须配置邮件；本地允许以上主机、账号、密码和发件地址全部留空。配置了一部分会明确报错，不能继续使用不完整配置。更改环境变量后重启应用。

完整配置会启用邮箱密码注册、注册验证邮件、未验证用户登录时重发验证邮件、密码重置邮件。邮箱验证完成前不能登录，密码重置成功后撤销已有会话。SMTP 使用加密传输；`SMTP_SECURE=false` 也要求服务器支持 STARTTLS。

主站前端通过现有 `authClient.signUp.email()`、`signIn.email()`、`sendVerificationEmail()`、`requestPasswordReset()` 和 `resetPassword()` 接口对接自己的注册、验证和重置页面。后台提供邮箱密码和可选 Google 登录入口，不包含主站注册页面。Google 配置与邮件独立，启用后生产仍需保留邮件配置，支持原有邮箱验证和密码恢复。

## Google 登录与账号绑定

在 `apps/dashboard/.env.local` 配置下列**服务端**变量：

| 环境变量 | 用途 |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google Auth Platform 创建的 Web application OAuth 客户端 ID |
| `GOOGLE_CLIENT_SECRET` | 同一 OAuth 客户端密钥，不使用 `NEXT_PUBLIC_` 前缀、不传给浏览器 |

两项都留空时关闭 Google 登录和绑定入口；只配置一项会明确报错。填好后重启后台，登录页将出现“使用 Google 账号登录”。本应用复用原生 Google provider，使用默认 `openid`、`email`、`profile` 权限和账号选择提示，不额外请求 Google API 访问权限。

在 [Google Auth Platform](https://console.cloud.google.com/auth/overview) 配置品牌与受众，创建 Web application 客户端，在 **Authorized redirect URIs** 添加：

```text
# 自带 Dashboard 本地开发
http://127.0.0.1:3001/api/auth/callback/google
# 生产：替换成实际 BETTER_AUTH_URL
https://你的网站域名/api/auth/callback/google
```

控制台回调与 `BETTER_AUTH_URL + /api/auth/callback/google` 必须精确一致。`localhost` 与 `127.0.0.1`、端口、协议、路径及末尾斜线都不能混用；生产使用 HTTPS。外部应用测试状态按控制台要求添加测试用户，正式发布/验证遵循 [Google 官方流程](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred)。

首次为既有管理员启用：

1. 先用原来的邮箱和密码登录。初始化不会把本地邮箱标成已验证，不能假设首次 Google 登录会自动合并管理员。
2. 点击顶部“绑定 Google 账号”，授权**同邮箱**的 Google 账号。成功后返回当前后台路径，原用户 ID 和管理员角色不变。
3. 退出后台，再点击“使用 Google 账号登录”，确认能够进入后台。

默认只允许同邮箱绑定，已绑定给其他用户的 Google 账号不能接管。已有本地邮箱已验证且 Google 邮箱也已验证时，认证核心允许默认的同邮箱关联；不降低本地邮箱验证或账号归属校验。首次 Google 登录新建的是普通网站用户，后台 API 仍返回 403，不会自动升级管理员。需要授权时由既有管理员在用户面板明确调整角色；初始化脚本不会将已存在用户提权。

取消 Google 授权会返回当前后台并显示提示。已有账号未关联时显示先登录再绑定的指引，绑定邮箱不一致时提示切换账号；未知错误显示通用失败信息，不把 `error_description` 当作页面内容。初始请求失败会恢复登录按钮，邮箱登录仍可使用。

网站直接接入的完整配置、路由、前端调用及常见错误见 [SDK Google 登录](../../packages/app-sdk/README.md#google-登录)。若将后台迁到 `/admin`，登录和绑定返回当前页面路径，Google 控制台回调仍指向认证路由 `/api/auth/callback/google`。

## 用户反馈工单

Dashboard 默认注册 `tickets()` 与 `ticketsClient()`，不需要新增环境变量。用户从登录页“提交与查看反馈”链接进入 `/support`，或直接打开此路径；页面支持现有邮箱密码与已配置的 Google 登录。普通用户无法进入管理员面板，但可以在反馈中心管理自己的工单。

用户可以填写标题（最多 200 字符）和问题描述（最多 10000 字符）、分页和按状态筛选自己的工单、阅读完整文字对话及追加回复。管理员打开“工单”页签，选择工单后回复，或通过状态按钮切换“待处理 / 处理中 / 已关闭”。状态变化保留在对话历史；已关闭工单须管理员重新打开后再回复。页面显示用户 ID 供管理员关联用户面板。

升级前备份数据库，使用**完整** `getAuth().options` 执行显式迁移，新增 `supportTicket`、`supportTicketEntry` 和复合唯一索引。已有安装不能重跑 `dashboard:setup` 来覆盖管理员；在网站现有迁移命令中调用原生 `getMigrations(auth.options).runMigrations()`。SQL 事务、Admin 审计表和唯一索引是必需条件。应用请求不会自动迁移。

回复、状态记录、revision 和管理员审计在同一事务提交；失败回滚，冲突提示刷新。界面复用现有会话存储重试机制：未确认请求复用同一个 UUID 和载荷，确认成功后清除。若存储不可用会明确阻止写入；刷新、关闭标签页或清理会话存储后，应先检查工单是否已保存，再决定是否创建新操作。工单内容按纯文本渲染，用户不能指定所有者、作者或管理员角色；删除账号保留工单历史及用户 ID。

网站独立接入、类型、迁移、服务端与浏览器接口及重试规则见 [SDK 工单说明](../../packages/app-sdk/README.md#用户反馈工单)。迁入已有网站时复制 `tickets-panel.tsx`、`ticket-thread.tsx` 并复用共享组件和网站 `authClient`；保留 `/support` 或改为网站自己的反馈路径。工单使用现有 `/api/auth` 路由，不接收邮件，不发送邮件提醒，本版不支持附件。

## 迁移与管理员初始化

`pnpm dashboard:setup` 是显式有副作用的初始化命令：验证环境后，使用 `getMigrations(auth.options).runMigrations()` 应用真实认证、目录、积分、业务和审计表迁移，再创建指定的新管理员并记录引导审计。请先核对目标数据库；已有业务库先备份并审查迁移。

指定邮箱已存在时，脚本明确退出，不覆盖密码、不修改角色；迁移可能已完成。需要恢复既有管理员访问时使用网站现有账户恢复/管理员流程，不要指望重复运行脚本将普通用户提权。后续迁移可使用网站已有迁移流程，或针对完整 `getAuth().options` 调用原生迁移器；初始化脚本不是密码重置工具。

认证由 `lib/auth.ts` 的 `getAuth()` 惰性创建。配置缺失或服务不可用时，`/api/auth/*` 返回明确失败，初始化异常响应为 503；不会泄露数据库 URL、密码或堆栈到浏览器。修复环境后重启后台。

## 接入已有网站

这个应用使用 SDK 入口及 `admin({ auditLog: true })`、`tickets()`、`subscription({ catalog: true })`、`credits()`、`business({ providers, orderTtlMs: 60 * 60_000 })`。`lib/payments.ts` 按环境配置注册 Stripe、PayPal 或 Waffo 适配器，`lib/email.ts` 提供 SMTP 邮件回调。迁入网站时复用网站的 **同一个 auth 实例、数据库、密钥和认证路由**，将 `getAuth()` 改为返回网站现有实例，并补齐上述插件、邮件回调、支付路由及对应迁移；不要重新维护一套互不相通的管理员和用户库。

将后台页面放到网站需要的路径（例如 `/admin`），客户端继续使用同源 `/api/auth`，付款返回页位于 `/payment/return`，支付通知路由位于 `/api/payments/webhook`。若调整这些路径，同步修改支付适配器的回调地址和渠道后台的通知配置。已有同源认证路由时复用它，避免安装第二个冲突的 `/api/auth/[...all]`。应用路由使用 Node.js runtime；权限由服务端检查，前端隐藏按钮不能替代授权。

迁入 Google 登录界面时，将 `public/google-g.png` 一起复制到网站的 `public/google-g.png`，并在网站服务端页面仅传递 Google 是否启用及安全错误提示；不要把 OAuth 凭据传给客户端组件。

浏览器调用 Admin 和 Business 客户端；购买者可以请求核验自己的订单，但不能提交“已付款”状态、付款金额或收款凭据来直接发放权益。套餐、会员和积分人工操作需要原因和稳定操作 ID，同一操作超时后重试复用原 ID 与载荷；商品使用版本校验，会员调整使用 revision 校验。遇到冲突应刷新数据后重新操作。

未确认操作的重试编号按管理员保存在当前标签页的 `sessionStorage` 中，关闭弹窗或刷新页面后可继续使用。关闭标签页、清理浏览器存储或换浏览器后，应先核对流水与审计，再决定是否重新操作。

## 收款配置

`PAYMENT_PROVIDER` 选择 `stripe`、`paypal` 或 `waffo`，一次启用一个渠道；留空或 `none` 关闭新购买。只需填写所选渠道的服务端配置，密钥不要使用 `NEXT_PUBLIC_` 前缀，也不要传给浏览器。

| 渠道 | 环境变量 | 渠道后台需要的通知事件 |
| --- | --- | --- |
| Stripe | `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET` | `checkout.session.completed`、`checkout.session.async_payment_succeeded` |
| PayPal | `PAYPAL_CLIENT_ID`、`PAYPAL_CLIENT_SECRET`、`PAYPAL_WEBHOOK_ID`、`PAYPAL_ENVIRONMENT` | `CHECKOUT.ORDER.APPROVED`、`PAYMENT.CAPTURE.COMPLETED` |
| Waffo Pancake | `WAFFO_MERCHANT_ID`、`WAFFO_PRIVATE_KEY`、`WAFFO_STORE_ID`、`WAFFO_PRODUCT_ID`、`WAFFO_ENVIRONMENT` | `order.completed` |

通知地址均为 `https://你的网站域名/api/payments/webhook`。它需要能被支付服务访问。Stripe 的签名密钥应属于该通知端点。PayPal 的 `WEBHOOK_ID` 是在该应用中创建通知端点所得的 ID，环境默认为 `sandbox`，上线时填写 `live` 并使用对应的正式凭据和通知 ID。

Waffo 配置步骤：

1. 在 Waffo「API 与开发」获取 Merchant ID 并创建对应环境的 API Key，将私钥仅保存到服务端 `WAFFO_PRIVATE_KEY`（PEM 或转义 `\n`）。`WAFFO_MERCHANT_ID` 不是 Store ID。
2. 从选定店铺获取 `WAFFO_STORE_ID`，创建或选用活跃的 **一次性 SaaS 商品**，填写 `WAFFO_PRODUCT_ID`；多个本地套餐共用该商品，订单快照决定价格。不会在启动或结账时自动创建店铺/商品。
3. `WAFFO_ENVIRONMENT=test` 使用测试私钥；生产改为 `prod` 并更换正式私钥，先完成商户审核、发布商品正式版本。店铺中注册对应环境的 `order.completed` 通知。
4. `BETTER_AUTH_URL` 必须为绝对 HTTPS 地址，返回页为 `/payment/return`。本地联调使用 ngrok HTTPS 地址；Waffo 支付渠道不接受 HTTP localhost 返回地址。

官方 SDK 固定为 `@waffo/pancake-ts` 0.26.0，需 Node.js 20+，已通过 `@app/auth-sdk/waffo` 导出。配置缺失、私钥错误、HTTP 返回地址、商品不属于店铺或误用订阅商品会明确报错。`WAFFO_ENVIRONMENT` 限制验签和付款核验环境；API 请求所用环境由 API Key 本身决定，不能用环境变量把测试私钥变成正式私钥。

Waffo 目录金额为**税前商品价**，Pancake 结账另计税额。SDK 精确转换 USD/EUR/GBP/HKD/CNY 的两位最小单位和 JPY 整数金额，回查付款时校验税前金额与总额组成；本地订单、统计和监控仍记录税前商品价。其他币种不支持。此版本遵循官方 SDK 已移除 `taxIncluded` 的接口，不采用 skill 旧示例中的含税开关。

价格、币种、积分数量、会员天数等在后台“商品套餐”维护并发布，结账使用订单保存的套餐快照；不需要为当前一次性购买流程填写 Stripe Price ID。价格必须为正数并符合所选渠道规则。PayPal 支持的币种有明确范围，JPY 使用整数金额，HUF/TWD 也必须是完整货币单位，不能带小数。

目录使用 ISO 最小货币单位；Stripe 自动转换 ISK/UGX、MGA 的渠道计价差异，拒绝非整单位 MGA 和未支持的三/四位小数币种。已有 HUF、MGA 等商品若通过旧版面板录入过，应在开启收款前核对价格；历史订单金额不会自动改写。

通知路由先验签，再查询支付渠道并交给 Business 核验订单和发放权益；处理失败返回 `503`，允许渠道重试。PayPal 已批准但尚未收款的订单由服务端捕获款项，使用稳定请求 ID，超时后禁止新的捕获；已完成付款即使通知晚到仍可核对。浏览器跳回成功页不视为付款凭据。

修改渠道配置后重启。切换渠道前先处理原渠道的待支付、待履约订单及待重试通知；当前只注册所选渠道，切换后无法继续通过本应用核验旧渠道的未处理付款。历史订单和统计仍保留。

## 主站购买接口

主站复用 `lib/auth-client.ts` 或在自己的客户端注册 `businessClient()`。以下接口都需要购买者登录，价格和权益由服务端确定：

| SDK 客户端调用 | 用途 |
| --- | --- |
| `authClient.business.providers()` | 返回已启用渠道名称，未配置时为空列表 |
| `authClient.business.products()` | 查询已发布套餐 |
| `authClient.business.orders.create({ productId, provider, idempotencyKey })` | 按套餐版本创建属于当前用户的订单 |
| `authClient.business.orders.checkout({ orderId })` | 创建或取回结账链接，返回订单的 `checkoutURL` |
| `authClient.business.orders.complete({ orderId })` | 通过 POST 请求服务端核验自己的订单并履约，不接受浏览器声明的付款结果 |
| `authClient.business.orders()` | 查询当前用户的订单 |

每次明确的新购买生成一个 `idempotencyKey` 并保存，网络失败后用同一编号重试创建；不要在每次点击或重试时生成新编号。打开 `checkoutURL` 前检查 SDK 返回的 `error`。Waffo 使用用户点击的 `<a target="_blank" rel="noopener noreferrer">` 在新标签页付款，保留主站页面；没有取消回调，成功后用户点击 Done 才跳回。用户返回 `/payment/return` 后可点击“查询付款结果”；请求使用登录会话及持久化的渠道订单 ID，返回 URL 中的 `token` 或 `reference` 不决定权益发放。

已验证但履约失败的订单可以在后台重试，重试不会再次收费。渠道通知也会触发同一核验与履约流程，因此用户关闭付款页面不影响已收到通知的订单处理。

## 付款统计

后台“付款统计”支持收入汇总、UTC 日/月趋势、客单价及新注册付费转化率。默认查询 UTC 本月至今天，日期范围最多 366 天；“结束日期”含当天。收入按币种分别呈现，图表可切换币种，趋势表可分页查看精确金额。用户模块打开“详情”，可查看该用户全部历史收款、已记录退款、净额、客单价及首末付款时间。

收款只来自已核验的本地业务订单。退款回冲原付款期，净额未扣手续费或成本，不是利润或按退款日期统计的现金流。转化率是所选期间注册且在同期间成功付款的当前账户数 / 期间当前注册账户数；无注册用户显示“—”，旧用户期间付款仍进入收入和付费人数，但不进入该新注册转化率。全额退款不撤销付款事实。

迁入网站时复用 `payment-statistics.tsx`、`payment-trend.tsx`、`payment-totals.tsx` 和 `customer-spending.tsx`，保留共享 UI、`lib/format.ts` 以及同一个 `authClient`。普通网站用户调用 `business.spending()` 只能读取自身累计消费；管理端使用 `business.admin.paymentStats()` / `business.admin.spending()`，详见 [SDK 付款统计接入](../../packages/app-sdk/README.md#用户付款统计)。

升级使用完整 auth 配置显式迁移，补齐 `businessOrder.paidAt` 索引，无新增统计表。单个查询最多 100000 笔符合条件的付款；超限、金额溢出或数据不一致会失败并提示重试，不显示截断汇总。支付渠道未核验/未同步的历史付款与退款不自动纳入；当前三个渠道的自动退款同步仍需另行接入。

## 功能范围

当前三个适配器均使用一次性付款，支持积分、按天会员、会员＋积分套餐；会员到期不会自动扣款，用户可再次购买。订单默认付款窗口为一小时；Stripe 创建结账时要求至少还剩 30 分钟，Waffo 要求剩余 1 分钟至 24 小时，应在创建订单后立即获取结账链接。Waffo 保存 checkout session ID，通过商户业务订单号回查付款；重复通知和浏览器查询共用业务付款去重，无需新表。

保留到期积分、实际付款触发的赠送、履约重试。Business 底层支持已完成退款的权益核对，但当前 Stripe/PayPal/Waffo 适配器未提供 `verifyRefund`，通知路由也未接入退款事件，因此不会自动同步渠道退款。渠道退款与相关权益需要人工核对处理，不实现 A6 的年付后定时分月赠送，也不实现 A7 的新增渠道自动扣款/直接发起退款。

## 监控接入

Dashboard 已集成 `business({ monitor: createMonitorOptions() })`、`instrumentation.ts` 常驻任务和“监控”页。复制 `.env.example` 中 `APP_MONITOR_*` 配置，先迁移完整 auth schema，再启用并重启服务。固定版本监控包位于工作区 `vendor/monitor-analytics-sdk-0.1.1.tgz`。独立部署时复制此包与 `auth-sdk.tgz`，无需访问原开发仓库。

完整配置和主站注册、OAuth 发起、下单时的 `monitorHeaders(monitor.getAttributionContext())` 用法见 [SDK 监控接入](../../packages/app-sdk/README.md#可信业务监控)。管理后台不新增公开注册页面；Google 登录和绑定位于现有登录页及管理员顶部。用户和订单详情显示各自已保存的归因；缺少线索时明确显示缺失。

“监控”页显示服务端站点、环境、接收地址、凭证是否配置、各投递状态计数与最近成功时间；不会接收或显示凭证。可按类型、状态、完整用户/订单 ID 查询，查看原始事件和安全失败原因，填写原因后安排补发。补发复用事件与审计操作 ID，不再次核验收款或发放权益。配置正确但尚无成功回执时显示“暂无成功投递”。关闭状态、空结果和加载失败分别展示。

后台 Node 进程启动后立即处理一轮，此后每 60 秒处理最多 20 条、并发 2；数据库租约支持多实例与进程重启。无需打开管理页面。该运行方式要求常驻 Node 服务；无常驻进程的部署应使用宿主已有调度调用仅服务端可用的 `auth.api.runMonitorDelivery()`。默认补发窗口为首次尝试后 7 天，必须小于 Collector 实际保留期（默认 30 天）。Collector 必须对同一站点的事件 UUID 去重。

新增表 `businessMonitorEvent`、用户内部注册字段和订单内部归因字段需要通过既有迁移流程发布。首次开启不补报历史；关闭时停止采集和投递、保留已有记录。退款监控、转化报表和新增收款渠道不在本版范围内。

## 检查与构建

```powershell
pnpm --filter @app/dashboard exec playwright install chromium
pnpm exec node --experimental-strip-types --test apps/dashboard/test/*.test.ts
pnpm dashboard:test
pnpm dashboard:build
```

浏览器仅需安装一次；已有可用 Chromium 时可跳过安装。配置和金额转换单元测试不连接数据库，初始化和 Google 回调测试使用独立 SQLite 文件；界面测试使用隔离的本地数据库和随机凭据。Google 回归覆盖凭据成对校验、授权地址与 PKCE、真实认证回调、既有管理员绑定、新用户普通角色、错误 audience、取消授权、错误提示、键盘和桌面/移动布局；仅 Google 远端响应使用明确的测试替身，不读取开发者 Google 凭据。部署后仍需使用真实 Google 客户端完成登录和绑定联调。支付与邮件测试使用模拟服务响应，不会实际扣款或发送邮件，也不能替代商户自身的沙箱联调。构建前先构建本地 SDK；工作区依赖由根目录 `pnpm-lock.yaml` 管理。

工单浏览器回归使用真实 SDK、认证接口和隔离 SQLite，覆盖用户提交与回复、跨用户隔离、管理权限、管理员回复与状态变更、关闭后禁止回复、重新打开、刷新持久化、纯文本展示及移动端明暗主题。SDK 回归另覆盖幂等重试、冲突检测、降权/封禁/模拟会话、CSRF 和审计失败回滚；不读取或迁移开发、生产数据库。

付款统计回归使用真实接口和隔离 SQLite 中明确标记的合成核验记录，验证 USD/JPY 分币种汇总、退款回冲、注册人群转化率、日/月切换、用户累计消费、空结果/非法日期、普通用户隔离及桌面/移动明暗布局。SDK 测试另验证 500 笔以上分页、首尾时间边界、未来付款排除、金额溢出、损坏退款记录和新旧用户口径；不访问支付渠道或生产付款数据。
