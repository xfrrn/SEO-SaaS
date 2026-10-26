# Auth SDK 0.2.0

本版本将已有的程序化认证与共享存储插件纳入统一 SDK 分发，并交付 i18n。上游 Better Auth 包保留 1.7.6 版本；应用 SDK 从 0.1.0 升为 0.2.0。

## 新增入口

| 入口 | 用途 |
| --- | --- |
| `@app/auth-sdk/api-key` | 程序化认证、密钥生命周期、权限和限流 |
| `@app/auth-sdk/api-key/client` | 已登录用户的密钥管理客户端 |
| `@app/auth-sdk/api-key/types` | API Key 配置与记录类型 |
| `@app/auth-sdk/redis-storage` | Redis secondary storage 适配器 |
| `@app/auth-sdk/mcp` | MCP OAuth 授权与受保护请求处理器 |
| `@app/auth-sdk/i18n` | 认证错误翻译插件、词典与配置类型 |
| `@app/auth-sdk/i18n/client` | 客户端类型推导 |
| `@app/auth-sdk/i18n/locales` | 22 种语言的认证错误词典 |

完整包递归携带本地 `@better-auth/api-key`、`@better-auth/redis-storage`、`@better-auth/mcp`、`@better-auth/oauth-provider` 和 `@better-auth/i18n` 的构建产物。普通第三方运行依赖仍由包管理器下载，未启用的插件不会自动注册。

## 安装与启用

从 GitHub Release 下载 `auth-sdk-0.2.0.tgz` 并放入网站的 `vendor/`：

```bash
pnpm add ./vendor/auth-sdk-0.2.0.tgz
# 仅启用 Redis 的网站需要：
pnpm add ioredis
```

API Key 和 MCP/JWT 必须注册到网站已有认证实例，然后按完整配置在测试库生成、核对并执行数据库迁移，再安排生产迁移。自有 API 路由须核验密钥和业务权限，MCP 工具须核验主体与 scope。Redis 连接、登录和同意页、MCP 协议传输与工具实现由宿主提供。CIMD 不包含在本次分发中。

完整配置见 [SDK 使用说明](../packages/app-sdk/README.md#程序化认证与共享存储)。

## 构建和回归

API Key 回归包含真实 PostgreSQL serial-ID 用例。执行前设置 `BETTER_AUTH_TEST_POSTGRES_URL` 指向隔离测试库；夹具自动创建并清理随机 schema。CI 使用独立 PostgreSQL 17 服务。MCP 的 `jose` 已与认证核心统一到仓库现有的 6.2.3，避免打包时安装版本冲突。

```bash
pnpm install --frozen-lockfile
pnpm pack:sdk
pnpm typecheck
pnpm test:sdk
pnpm test:packaging
```

打包回归核验新增入口的运行时导入和 TypeScript 类型、递归依赖、ioredis 可选声明、未认证 MCP 请求拒绝，以及中文认证错误响应。Redis 单元测试通过受控客户端验证适配器命令，不代表真实 Redis 多实例部署验收；本版本不替网站执行生产迁移或部署。

2026-10-26 本地验收：全仓构建与类型检查通过；SDK 47 个测试文件、724 项测试通过，无跳过；打包 2 项回归通过；实际 `.tgz` 在仓库外使用 pnpm 11 安装并导入新增入口成功，未认证 MCP 请求返回 401，未安装 ioredis 时其余入口正常工作。改动源码的 Biome 检查通过。
