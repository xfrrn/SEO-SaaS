# 认证与支付 SDK

`@app/auth-sdk` 提供 Better Auth 服务端、客户端插件、React、Next.js 和 Stripe 入口，保持原生参数、返回值和类型推导；另提供 PayPal 一次性付款客户端。

## 安装

将仓库根目录执行 `pnpm pack:sdk` 生成的 `dist/auth-sdk.tgz` 复制到使用方项目：

```bash
pnpm add ./vendor/auth-sdk.tgz
```

此安装包内含本地构建的 Better Auth 核心及其工作区运行依赖，无需另外安装公共版本 `better-auth`。第三方运行依赖由包管理器安装；数据库驱动由使用方选择。React、Next.js、Stripe 只在使用对应入口时需要。

## 导入入口

| 入口 | 内容 |
| --- | --- |
| `@app/auth-sdk/server` | `betterAuth` 和服务端类型 |
| `@app/auth-sdk/plugins` | 内置服务端插件 |
| `@app/auth-sdk/client/plugins` | 内置客户端插件 |
| `@app/auth-sdk/react` | `createAuthClient`，含 `useSession` |
| `@app/auth-sdk/next-js` | `toNextJsHandler`、`nextCookies` |
| `@app/auth-sdk/stripe` | Stripe 服务端插件 |
| `@app/auth-sdk/stripe/client` | `stripeClient` |
| `@app/auth-sdk/paypal` | PayPal 订单、收款确认与 webhook 验签 |

服务端使用 `betterAuth({ database, secret, baseURL, ... })` 配置认证，再将请求交给 `auth.handler(request)`。会话检查必须传当前请求头：`auth.api.getSession({ headers: request.headers })`。

SDK 不启动 HTTP 服务、不提供页面。密钥与数据库配置留在使用方服务端，数据库表需要预先迁移。PayPal 入口仅供服务端使用，默认沙箱，支持一次性付款，不含自动续费。

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

请用根目录 `pack:sdk` 生成完整安装包；直接打包本目录只包含入口层。其他独立插件仍保留在工作区中，可按需构建和接入。
