# SDK 0.5.0：积分商品购买策略与订单报价

兼容 0.4.0 的认证、支付、原生积分账本和中台客户端。`@app/business` 升级至 0.2.0；Engine 的审核核心仍可固定 0.4.0。本次不添加订阅、收款渠道或第二套账本。

积分商品通过版本化 `limits.purchase` 保存 `{ maxPerUser: number | null, firstPurchaseOffer: null | { type: "fixed", amount: number } | { type: "percent", percentOff: number } }`。金额为币种最小单位，百分比以整数四舍五入，禁止优惠后零元或固定首购价大于等于原价。没有此字段的旧商品默认不受限，旧客户端仍可购买。

认证客户端先调用 `business.orders.quote({ productId })`，取得原价、实付、优惠、首次购买、成功次数、剩余次数、可购状态、原待支付订单 ID 和 `quoteVersion`。创建订单提交该版本：`business.orders.create({ productId, provider, idempotencyKey, quoteVersion })`。受限或带首购优惠的商品必须报价；传入过期报价或已被新版本替换的商品返回 HTTP 409 / `PURCHASE_QUOTE_CHANGED`。客户端须刷新展示并由用户重新确认，不能自动按新价重下单。

资格按 `referenceId + productKey` 累计已核验付款（`paidAt`），不等待积分履约，不因退款、编辑名称或创建新商品版本恢复。现有用户级 SQL 事务同时计算资格和写入订单，限制商品一次仅保留一笔待付款，跨渠道、标签页和实例共同生效。相同幂等键先恢复原订单，再检查新规则。订单固定 `product`、`amount` 和 `pricing` 快照，支付、退款、统计继续以 `amount` 为准。

`business.orders.reconcileCheckout({ orderId })` 只查询本人的订单。未启动过结账的新订单过期后可确认关闭；已经启动的结账只有渠道证明未付款且永久关闭才能释放。适配器可实现 `inspectCheckout()` 返回 `open | paid | closed | unknown`，其中 `closed` 必须保证旧链接无法付款。PayPal 映射 `VOIDED` 为关闭、`COMPLETED` 为已付款；其他状态保留占用。没有关闭查询能力的渠道继续调用既有付款核验；无法确认时返回 `PURCHASE_PAYMENT_UNCONFIRMED`，不会按本地超时猜测关闭。Waffo 当前属于此边界。

已核验的迟到付款继续按原订单履约，重复核验或履约重试不重复入账；若与后续购买资格冲突则标记 `reviewRequired` 供后台人工核对，不丢弃付款。

升级须先迁移完整 auth schema：`businessOrder.pricing`（可选 JSON）、`checkoutStartedAt`、`checkoutClosedAt`（可选时间），保留原 `businessCustomer.referenceId` 与 `businessOrder.checkoutKey` 唯一索引。旧订单空字段保持原含义，无法证明从未启动过结账的旧订单不会自动释放。

中台客户端模板响应新增 `supported_output_resolutions: string[]`，从服务端公开元数据读取，旧中台没有此字段时返回空列表，宿主不能据此猜测支持清晰度。它只表达执行能力，积分价格仍由宿主配置。
