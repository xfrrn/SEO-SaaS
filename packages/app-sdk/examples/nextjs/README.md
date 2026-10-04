# Next.js 接入示例

这是可复制到已有 **Next.js App Router、React、Node.js** 项目的文件，不是另一个独立 workspace。示例使用 PostgreSQL 的 `pg.Pool`。

1. 按 SDK 中文快速接入指南安装本地 SDK 包及基础依赖。
2. 复制 `lib/`、`app/api/auth/[...all]/route.ts` 到项目根目录。若项目使用 `src/`，复制到 `src/` 下。已有 `app/layout.tsx` 不要覆盖；`app/page.tsx` 可复制为任意登录页面。
3. 复制 `.env.example` 为项目根目录的 `.env`，填写前三个变量，保持密钥只在服务端。
4. 使用 `npx auth@latest migrate --config ./lib/auth.ts` 建表；`src/` 项目将路径改为 `./src/lib/auth.ts`。执行前备份已有数据库，并检查迁移内容。
5. 在现有项目运行 `pnpm exec next dev`。同域接口默认挂载到 `/api/auth`。

此示例 `tsconfig.json` 的 `@/*` 指向根目录；`src/` 项目应使用 `"@/*": ["./src/*"]`。配置 Prisma／Drizzle 时保留现有连接对象，用其 Better Auth 适配器替换 `auth.ts` 的 `database`，不再导入本示例的 `pg` 连接池。

## 开启个人订阅

安装支付依赖后，将 `billing/` **里面的内容**复制到同一项目根目录（或 `src/`），覆盖 `lib/auth.ts`、`lib/auth-client.ts`，新增 `/billing` 和 `/api/premium`。保留基础示例的 `lib/database.ts` 与 `lib/env.ts`。不要把 `billing/` 文件夹原样放进 `app/`。

填写剩余 Stripe 环境变量，在测试环境创建 Basic、Pro 两个产品，每个产品各有一个月付和年付的 recurring price。服务端的套餐名称必须与客户端 `plan` 一致。再次执行数据库迁移以新增订阅表和客户字段，再启动应用。`nextCookies()` 保持最后一个插件。

Stripe webhook 地址为 `/api/auth/stripe/webhook`；本地调试可运行 `stripe listen --forward-to localhost:3000/api/auth/stripe/webhook`，把输出的签名密钥填入 `STRIPE_WEBHOOK_SECRET`。在 Dashboard 启用客户门户，配置允许取消订阅与更新支付方式。具体事件和线上配置见中文快速接入指南。

登录后访问 `/billing`：支持月付／年付、Basic／Pro 切换、刷新有效订阅、取消、撤销待生效的取消和账单门户。切换时传入现有的 `stripeSubscriptionId`，不是数据库记录的 `id`。未完成的 Checkout 请回到原页面完成，避免在多个标签页同时开始购买。

`/api/premium` 演示服务端付费授权：传入请求头读取登录用户和订阅，未登录返回 401，无有效个人订阅返回 403。返回成功页面和客户端显示的状态都不作为权限凭证。

## 开启 PayPal 一次性付款

将 `paypal/` 内的 `app/`、`lib/` 合并到应用根目录（或 `src/`），保留基础认证配置。填写 `.env.example` 中的 PayPal 变量，在同一 PostgreSQL 数据库执行 `paypal/migrations/001_paypal.sql`；Better Auth CLI 不会创建这些支付业务表。登录后访问 `/paypal`，默认演示商品价格为 10.00 USD，修改服务端商品配置后再上线。

配置 webhook 到 `/api/paypal/webhook`，使用真实沙箱交易验证到账和退款。完整配置、事件列表、接口与上线检查见 [PayPal 中文接入手册](../../../../docs/content/docs/guides/sdk-paypal-zh.mdx)。

## 在本仓库验证

先构建 SDK 及其依赖，然后执行：

```sh
pnpm --filter @app/auth-sdk typecheck:example
pnpm --filter @app/auth-sdk build:example
pnpm exec vitest run packages/app-sdk/examples/nextjs/example.test.ts
```

构建需要前三个环境变量；PostgreSQL 在真正调用认证接口时需要可连接。支付模板可以独立通过类型检查。生产密码找回、邮件验证与旧用户迁移按实际项目另行配置；此示例默认开启邮箱密码注册登录。
