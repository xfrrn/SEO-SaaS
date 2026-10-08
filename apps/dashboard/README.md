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

访问 `http://127.0.0.1:3001`，使用初始化时设置的凭据登录。`BETTER_AUTH_URL` 与浏览器访问地址应保持一致，不要混用 `localhost` 与 `127.0.0.1`。初始化完成后从 `.env.local` 移除 `DASHBOARD_ADMIN_PASSWORD`；运行应用无需保留初始化凭据。

本地 SQLite 文件路径相对于后台工作目录 `apps/dashboard`。应用使用真实持久化 SQLite，不是内存演示库；`NODE_ENV=production` 明确禁止 SQLite，生产配置 PostgreSQL。应用默认关闭公开注册，不会自动创建管理员、迁移数据库或发放测试积分。

## 迁移与管理员初始化

`pnpm dashboard:setup` 是显式有副作用的初始化命令：验证环境后，使用 `getMigrations(auth.options).runMigrations()` 应用真实认证、目录、积分、业务和审计表迁移，再创建指定的新管理员并记录引导审计。请先核对目标数据库；已有业务库先备份并审查迁移。

指定邮箱已存在时，脚本明确退出，不覆盖密码、不修改角色；迁移可能已完成。需要恢复既有管理员访问时使用网站现有账户恢复/管理员流程，不要指望重复运行脚本将普通用户提权。后续迁移可使用网站已有迁移流程，或针对完整 `getAuth().options` 调用原生迁移器；初始化脚本不是密码重置工具。

认证由 `lib/auth.ts` 的 `getAuth()` 惰性创建。配置缺失或服务不可用时，`/api/auth/*` 返回明确失败，初始化异常响应为 503；不会泄露数据库 URL、密码或堆栈到浏览器。修复环境后重启后台。

## 接入已有网站

这个应用使用 SDK 入口及 `admin({ auditLog: true })`、`subscription({ catalog: true })`、`credits()`、`business({ providers: {} })`。迁入网站时复用网站的 **同一个 auth 实例、数据库、密钥和认证路由**，将 `getAuth()` 改为返回网站现有实例，并在该实例上补齐上述插件及对应迁移；不要重新维护一套互不相通的管理员和用户库。

将后台页面放到网站需要的路径（例如 `/admin`），客户端继续使用同源 `/api/auth`；保留已有网站登录方式和用户注册策略。当前独立应用的 `disableSignUp: true` 只用于默认后台部署，不必覆盖主站原有注册策略。已有同源认证路由时复用它，避免安装第二个冲突的 `/api/auth/[...all]`。认证 API 使用 Node.js runtime；权限由服务端检查，前端隐藏按钮不能替代授权。

浏览器只调用 Admin 和 Business 客户端；付款核验、退款核验没有浏览器写入口。套餐、会员和积分人工操作需要原因和稳定操作 ID，同一操作超时后重试复用原 ID 与载荷；商品使用版本校验，会员调整使用 revision 校验。遇到冲突应刷新数据后重新操作。

未确认操作的重试编号按管理员保存在当前标签页的 `sessionStorage` 中，关闭弹窗或刷新页面后可继续使用。关闭标签页、清理浏览器存储或换浏览器后，应先核对流水与审计，再决定是否重新操作。

## 支付与功能范围

默认 `providers: {}` 表示没有配置收款渠道，面板应展示未配置状态；已有历史付款统计仍按实际记录展示。本站点提供经过验证的 `BusinessPaymentProvider` 后，才可进行购买和付款履约。需要复用现有 PayPal/Stripe 封装、服务端验签及付款回查，再在可信回调中调用 Business 的确认方法，不能把浏览器的“付款成功”参数当作收款凭据。

保留三类商品（积分、会员、会员＋积分）、到期积分、实际付款触发的赠送、履约重试、已完成退款后的权益核对。不实现 A6 的年付后定时分月赠送，也不实现 A7 的新增渠道自动扣款/直接发起退款。部分退款或已消费积分可能需要人工复核，后台不提供虚假的“一键解决退款”按钮。

## 检查与构建

```powershell
pnpm --filter @app/dashboard exec playwright install chromium
pnpm exec node --experimental-strip-types --test apps/dashboard/test/*.test.ts
pnpm dashboard:test
pnpm dashboard:build
```

浏览器仅需安装一次；已有可用 Chromium 时可跳过安装。配置和金额转换单元测试不连接数据库，初始化测试使用独立 SQLite 文件；界面测试使用隔离的本地数据库和随机凭据。构建前先构建本地 SDK；工作区依赖由根目录 `pnpm-lock.yaml` 管理。
