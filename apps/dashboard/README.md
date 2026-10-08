# Dashboard

基于用户提供的 `D:/codes/SEO/模板/Dashboard-finance-tracker` 复制后裁剪，原模板未修改。保留模板的排版、配色、主题切换、横向 Tabs、图表和弹窗过渡动效，改为连接本仓库真实 SDK 的独立后台。首页风格不必与后台一致。

保留概览、用户与会话、商品套餐、订单与履约重试、会员、积分流水与人工调整、操作记录。移除原来的个人财务假数据、收支/储蓄/贷款/目标演示、追踪脚本及不使用的界面组件。生产界面不以演示数据替代接口失败。

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

本地 SQLite 文件路径相对于后台工作目录 `apps/dashboard`。应用使用真实持久化 SQLite，不是内存演示库；`NODE_ENV=production` 明确禁止 SQLite，生产配置 PostgreSQL。本地未配置邮件时关闭公开注册；配置完整后启用邮箱注册和验证。应用不会自动创建管理员、迁移数据库或发放测试积分。

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

主站前端通过现有 `authClient.signUp.email()`、`signIn.email()`、`sendVerificationEmail()`、`requestPasswordReset()` 和 `resetPassword()` 接口对接自己的注册、验证和重置页面。后台只提供管理员登录入口，不包含主站注册页面，也未启用 Google、GitHub 等第三方登录。

## 迁移与管理员初始化

`pnpm dashboard:setup` 是显式有副作用的初始化命令：验证环境后，使用 `getMigrations(auth.options).runMigrations()` 应用真实认证、目录、积分、业务和审计表迁移，再创建指定的新管理员并记录引导审计。请先核对目标数据库；已有业务库先备份并审查迁移。

指定邮箱已存在时，脚本明确退出，不覆盖密码、不修改角色；迁移可能已完成。需要恢复既有管理员访问时使用网站现有账户恢复/管理员流程，不要指望重复运行脚本将普通用户提权。后续迁移可使用网站已有迁移流程，或针对完整 `getAuth().options` 调用原生迁移器；初始化脚本不是密码重置工具。

认证由 `lib/auth.ts` 的 `getAuth()` 惰性创建。配置缺失或服务不可用时，`/api/auth/*` 返回明确失败，初始化异常响应为 503；不会泄露数据库 URL、密码或堆栈到浏览器。修复环境后重启后台。

## 接入已有网站

这个应用使用 SDK 入口及 `admin({ auditLog: true })`、`subscription({ catalog: true })`、`credits()`、`business({ providers, orderTtlMs: 60 * 60_000 })`。`lib/payments.ts` 按环境配置注册 Stripe 或 PayPal 适配器，`lib/email.ts` 提供 SMTP 邮件回调。迁入网站时复用网站的 **同一个 auth 实例、数据库、密钥和认证路由**，将 `getAuth()` 改为返回网站现有实例，并补齐上述插件、邮件回调、支付路由及对应迁移；不要重新维护一套互不相通的管理员和用户库。

将后台页面放到网站需要的路径（例如 `/admin`），客户端继续使用同源 `/api/auth`，付款返回页位于 `/payment/return`，支付通知路由位于 `/api/payments/webhook`。若调整这些路径，同步修改支付适配器的回调地址和渠道后台的通知配置。已有同源认证路由时复用它，避免安装第二个冲突的 `/api/auth/[...all]`。应用路由使用 Node.js runtime；权限由服务端检查，前端隐藏按钮不能替代授权。

浏览器调用 Admin 和 Business 客户端；购买者可以请求核验自己的订单，但不能提交“已付款”状态、付款金额或收款凭据来直接发放权益。套餐、会员和积分人工操作需要原因和稳定操作 ID，同一操作超时后重试复用原 ID 与载荷；商品使用版本校验，会员调整使用 revision 校验。遇到冲突应刷新数据后重新操作。

未确认操作的重试编号按管理员保存在当前标签页的 `sessionStorage` 中，关闭弹窗或刷新页面后可继续使用。关闭标签页、清理浏览器存储或换浏览器后，应先核对流水与审计，再决定是否重新操作。

## 收款配置

`PAYMENT_PROVIDER` 选择 `stripe` 或 `paypal`，一次启用一个渠道；留空或 `none` 关闭新购买。只需填写所选渠道的服务端配置，密钥不要使用 `NEXT_PUBLIC_` 前缀，也不要传给浏览器。

| 渠道 | 环境变量 | 渠道后台需要的通知事件 |
| --- | --- | --- |
| Stripe | `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET` | `checkout.session.completed`、`checkout.session.async_payment_succeeded` |
| PayPal | `PAYPAL_CLIENT_ID`、`PAYPAL_CLIENT_SECRET`、`PAYPAL_WEBHOOK_ID`、`PAYPAL_ENVIRONMENT` | `CHECKOUT.ORDER.APPROVED`、`PAYMENT.CAPTURE.COMPLETED` |

两者的通知地址均为 `https://你的网站域名/api/payments/webhook`。它需要能被支付服务访问；本地回环地址只用于浏览器跳转，不能直接接收外部通知。Stripe 的签名密钥应属于该通知端点。PayPal 的 `WEBHOOK_ID` 是在该应用中创建通知端点所得的 ID，环境默认为 `sandbox`，上线时填写 `live` 并使用对应的正式凭据和通知 ID。

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

每次明确的新购买生成一个 `idempotencyKey` 并保存，网络失败后用同一编号重试创建；不要在每次点击或重试时生成新编号。跳转到 `checkoutURL` 前检查 SDK 返回的 `error`。用户返回 `/payment/return` 后可点击“查询付款结果”；请求使用登录会话及持久化的渠道订单 ID，返回 URL 中的 `token` 或 `reference` 不决定权益发放。

已验证但履约失败的订单可以在后台重试，重试不会再次收费。渠道通知也会触发同一核验与履约流程，因此用户关闭付款页面不影响已收到通知的订单处理。

## 功能范围

当前两个适配器均使用一次性付款，支持积分、按天会员、会员＋积分套餐；会员到期不会自动扣款，用户可再次购买。订单默认付款窗口为一小时；Stripe 创建结账时要求至少还剩 30 分钟，应在创建订单后立即获取结账链接。

保留到期积分、实际付款触发的赠送、履约重试。Business 底层支持已完成退款的权益核对，但当前 Stripe/PayPal 适配器未提供 `verifyRefund`，通知路由也未接入退款事件，因此不会自动同步渠道退款。渠道退款与相关权益需要人工核对处理，不实现 A6 的年付后定时分月赠送，也不实现 A7 的新增渠道自动扣款/直接发起退款。

## 监控接入

Dashboard 已集成 `business({ monitor: createMonitorOptions() })`、`instrumentation.ts` 常驻任务和“监控”页。复制 `.env.example` 中 `APP_MONITOR_*` 配置，先迁移完整 auth schema，再启用并重启服务。固定版本监控包位于工作区 `vendor/monitor-analytics-sdk-0.1.1.tgz`。独立部署时复制此包与 `auth-sdk.tgz`，无需访问原开发仓库。

完整配置和主站注册、OAuth 发起、下单时的 `monitorHeaders(monitor.getAttributionContext())` 用法见 [SDK 监控接入](../../packages/app-sdk/README.md#可信业务监控)。管理后台自身不新增公开注册或 OAuth 页面。用户和订单详情显示各自已保存的归因；缺少线索时明确显示缺失。

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

浏览器仅需安装一次；已有可用 Chromium 时可跳过安装。配置和金额转换单元测试不连接数据库，初始化测试使用独立 SQLite 文件；界面测试使用隔离的本地数据库和随机凭据。支付与邮件测试使用模拟服务响应，不会实际扣款或发送邮件，也不能替代商户自身的沙箱联调。构建前先构建本地 SDK；工作区依赖由根目录 `pnpm-lock.yaml` 管理。
