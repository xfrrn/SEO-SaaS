# Auth SDK 0.3.0

本版本新增 SeeAPI 审核与 Kie.ai Market 生成适配器。SDK 从 0.2.0 升至 0.3.0，上游 Better Auth 包版本保持不变。

## 新增能力

- `@app/auth-sdk/moderation` 新增 `createSeeAPIModerationDetector`：文字、NSFW Filter 2.0 图片，以及供应商视频抽样审核。结果缺失、超时、余额不足等不放行；请求重试沿用稳定的租户隔离幂等键。
- 新增 `@app/auth-sdk/generation/providers/kie`：Market 图片和视频任务提交、认证轮询、显式模型映射与受限文件下载；提交结果不确定时沿用待对账流程，不自动重提。
- 提供 Nano Banana 2 图片与 Grok 视频的适用参数和映射示例，及 SeeAPI 审核前置、私有结果审核、交付授权和撤权联动说明。
- 审核检测调用新增可选 `execution_key`，决策新增可选 `provider_evidence`。保留既有抽帧合同；无需新增业务表或重写旧记录。

## 安装

下载 Release 中的 `auth-sdk-0.3.0.tgz`，放入网站 vendor 后执行：

```bash
pnpm add ./vendor/auth-sdk-0.3.0.tgz
```

凭据、模型、阈值、素材解析和 CDN 白名单由宿主服务端配置，安装不自动启用服务。完整示例及 `.env.example` 位置见 [SeeAPI / Kie.ai 接入](https://github.com/xfrrn/SEO-SaaS/blob/auth-sdk-v0.3.0/docs/seeapi-kie-usage.md)。

## 验收边界

新增供应商传输测试和真实 SQL 的跨模块联动回归，上游 HTTP 使用明确的合成响应。真实供应商实测未完成；未执行付费请求，未验收阈值校准、真实私有 URL/CDN 或生产部署。

2026-10-26 本地验证：全仓构建和类型检查通过，50 个测试文件、780 项测试通过，无跳过；2 项打包回归通过。实际 `.tgz` 在仓库外使用 pnpm 11 安装，新入口的 SeeAPI 检查及 Kie 提交/轮询通过合成 HTTP 运行验证；20 个改动源码/配置文件的 Biome 检查通过。模型绑定条件的故障注入能被回归检出，已恢复并完成最终回归。

SeeAPI 视频只审核抽样帧，最多 30 秒、100 MB，不覆盖音轨；缺失专项字段不能作为通过。Kie.ai 首期仅覆盖 Market 图片/视频，不包含聊天、音乐、独立专用协议、自动上传或公共回调路由。本次不修改 SEO-Worker、不升级具体网站或执行生产迁移。
