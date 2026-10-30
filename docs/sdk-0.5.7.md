# SDK 0.5.7：配乐与衍生成片交付

服务端 `@app/auth-sdk/media-engine` 兼容新增可空、可省略的 `MediaGeneration.soundtrack`，签名 Webhook 使用同一结构。旧任务和无配乐模板不需要回填。`MediaSoundtrack` 固定音频 ID / content_revision，以及从 0 秒、音量 1、短则循环、长则截断到视频长度、替换原音轨的规则；不允许客户端改成混音、改音量或指定其他长度。

消费网站在原视频成功且积分已结算后，用已验证会话建立 `{user_id}` 上下文：

```ts
const audio = await engine.soundtrackURL(context, generationId);
const files = await engine.derivatives(context, generationId);
const prepared = await engine.prepareDerivative(context, generationId, {
  variant: 'soundtrack', // 或 muted
  max_size_bytes: configuredOutputByteCap,
});
// 可信网站处理器只收到临时源链接与 prepared.upload；不下发应用密钥或桶密钥。
// 上传实际生成的 MP4 后封存；complete 不是探测/审核成功证明。
const checked = await engine.completeDerivative(context, generationId, prepared.derivative.id);
// ready 后，每次预览/下载重新申请当前授权。
const grant = await engine.derivativeURL(context, generationId, checked.id);
```

接口均为原任务范围：GET/POST `/v1/generations/{id}/derivatives`、POST `/v1/generations/{id}/derivatives/{derivativeId}/complete`、GET 同资源 `/url`。列表只返回 items；POST 返回 derivative 和可选 upload（url、headers、expires_in、max_size_bytes），已存在结果可能没有新上传授权。最大字节数首次固定，重复请求不能扩大；source_video_asset_id / content_revision、soundtrack 和 rules_version=1 由 Engine 固定。`MediaDerivative` 保留 environment，沿用客户端 live / sandbox 绑定校验。

`soundtrackURL` 使用 GET `/v1/generations/{id}/soundtrack-url`，只返回本任务允许的音频内容版本、类型、固定规则和短期 URL。不能拿音频 ID 调普通 assetURL 读取管理员库。无配乐继续只准备静音版，不从展示参考片或供应商原音轨猜测配乐。

上传完成后可能为 pending / checking / ready / failed / unavailable；文件仍需 Engine 探测、publication 审核及源任务授权。下载响应包含 derivative、asset、url 和 expires_in；不应永久保存短链。410 表示源或文件失效，409 表示当前不可交付，503 表示暂时无法授权；SDK 保留错误码和状态，不自动重试，更不会再创建供应商任务或改积分。

原 `generation.output.asset_id`、生成幂等、审核终态和积分结算完全不变。合成重试只针对派生文件。SDK 不增加 FFmpeg、对象存储凭据、上传执行器或定时清理器；清理和来源依赖归 Engine 管理。固定中央审核核心 0.4.0 不变。
