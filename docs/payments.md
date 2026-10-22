# 支付商接入

模板内置 Waffo Pancake、Dodo Payments 和 Stripe，本地和 e2e 用 `mock`。本文说明支付商代码要遵守的约定，以及新增一个支付商要改哪些地方。各支付商的后台配置和实测行为见 README 的“第三方回调地址”。

## 数据流

```text
下单  POST /api/checkout → provider.createCheckout → 跳转支付商收银台
付款  支付商 webhook → verifyXxxWebhook → normalizeXxxEvent → processPaymentEvent
补救  成功页 / Cron / 后台“查单” → reconcileOrder → provider.fetchPaidEvent → processPaymentEvent
退款  后台退款 → provider.refund（只提交）→ 退款 webhook → processPaymentEvent 回收积分
```

业务逻辑只认归一化后的 `PaymentEvent`（`src/server/payments/types.ts`），不读支付商的原始字段。入账、核对和幂等都在 `src/server/orders.ts` 的 `processPaymentEvent` 里完成，支付商代码不碰数据库。

## 支付商代码的职责

| 函数 | 职责 | 失败时 |
| --- | --- | --- |
| `createCheckout(input)` | 用 `<X>_PRODUCTS[packageId]` 对应的商品创建收银台。`metadata` 至少带 `orderId` 和 `site`（`site.domain`），回跳地址用 `input.successUrl` | 没配置时抛 `ApiError(503, 'payment_not_configured')`，支付商报错时抛 `ApiError(502, 'payment_provider_error')`。错误信息不能带密钥 |
| `verifyXxxWebhook(raw, …)` | 用原始请求体验签，并检查时间戳容差和 test/live 模式 | 抛 `WebhookVerificationError`，接口返回 401 `{"error":"invalid_webhook"}` |
| `normalizeXxxEvent(payload)` | 映射成 `paid`、`refunded`、`failed` 或 `ignored` | 不认识的事件类型返回 `ignored`，不要抛错 |
| `refund(input)`（可选） | 只负责向支付商提交退款，返回退款单号；积分在退款 webhook 到达时才回收 | 业务冲突（余额不足、已退过）抛 409，带上支付商给的原因 |
| `cancelSubscription`、`resumeSubscription`、`portalUrl`（可选） | 订阅的到期取消、撤销取消和客户门户地址，见下面的“订阅” | 支付商不支持时不实现，账单页会隐藏对应按钮或引导去门户 |
| `fetchPaidEvent(order)`（可选） | 向支付商查这笔订单，只在明确付款成功时返回 `paid` 事件，字段和 webhook 的 paid 事件用同一套规则归一化。`eventId` 用 `reconcile:<支付商付款 ID>`，和 webhook 的事件 ID 不同，所以要靠积分流水的 `order:<id>` 幂等键防止重复入账 | 未付款、失败或处理中都返回 `null`，订单保持 pending；调用接口出错时直接抛错 |

归一化事件里的字段：

- `eventId`：支付商的事件 ID，重复投递时保持不变。`payment_events (provider, event_id)` 唯一，用来去重。
- `orderId`：从 `metadata` 里取。取不到时，`processPaymentEvent` 会依次按 `providerPaymentId`、`providerOrderId`（或 checkout session ID）反查订单。
- `paidAmountCents` 和 `paidCurrency`：实收金额（含税，最小货币单位）和币种，用于少付核对。拿不到就填 `null`，跳过金额核对。
- `productId` 和 `packageId`：实际购买的商品，用于防止买错商品，至少填一个。
- `discounted`：用了折扣码。为 true 时不核对金额。
- `refundId`：同一笔退款重试时保持不变，用作积分回收的幂等键（`order_refund:<orderId>:<refundId>`）。
- `refundAmountCents`：部分退款的金额；`null` 表示全额退款。
- `subscription`（paid 事件）：订阅扣款时填 `providerSubscriptionId`，能拿到的话再填 `providerCustomerId` 和本次扣款覆盖的 `periodStart`、`periodEnd`；一次性付款填 `null`。
- `kind: 'subscription'` 事件：订阅状态变化，`status` 映射成 `active`、`past_due`、`canceled`、`expired`（不认识的填 `null`，只更新其他字段），`cancelAtPeriodEnd` 表示到期取消，`occurredAt` 用支付商给的事件时间。

## 订阅

订阅由 `site.subscriptionsEnabled` 开关控制，模板默认开着：月付 $14.90、年付 $149，每月都发 60 积分。关掉后只卖积分包，定价页、条款、退款政策和 FAQ 里的订阅文案一起隐藏，已有订阅照常续费。开关、改套餐和支付商配置见 [subscriptions.md](subscriptions.md)，这里只讲入账规则。

规则：

- 每次扣款都是一张订单。首付用下单时建的订单；续费订单的 id 由 `ord_` 加 sha256(`<provider>:<付款 ID>`) 的前 24 位组成，同一笔扣款重复投递只建一次。续费金额按订阅时锁定的价格核对，对不上记为 mismatch。
- 订阅积分是有到期时间的批次（流水 reason 为 `subscription`），当月结束作废，生成时先扣快到期的。月付每期发一次，到期时间就是支付商给的当期结束时间。年付首付只发第一个月，其余 11 个月由 Cron（`grantDueSubscriptions`）按月补发：幂等键 `subscription_grant:<订单>:<k>`，Cron 停过几天时一次补齐，已经整月过去的月份跳过，补发的积分累加到订单的 `credits`。
- 状态事件按发生时间（`occurredAt` 对比 `subscriptions.state_at`）防乱序，迟到的旧事件返回 ignored。到期取消且当期已经结束的订阅不再算有效，即使终止事件丢了，用户也能重新订阅。
- 同一用户同时只能有一个有效订阅，再次下单返回 409 `subscription_exists`。还会自动续费时不能注销账号（409 `subscription_active`），要先取消续费，否则注销后支付商还会继续扣款。
- 退款只回收这张订单发过的订阅积分：回收量 = 已发放积分 × 退款比例，不碰积分包。当期订单退款后不再补发。退款不会取消订阅，要停止续费需另外取消。
- 不支持：换套餐（升降级），请在支付商的客户门户里关掉换套餐；试用期；暂停订阅（Dodo 的 paused 状态不处理）。

两家支付商的差异：

| | Dodo | Waffo |
| --- | --- | --- |
| 扣款事件 | `payment.succeeded`，带 `subscription_id` 和 `service_periods`（本次覆盖的周期） | `subscription.payment_succeeded`，不带周期：先按付款时间推算，状态事件到达后校正周期，当期积分的到期时间跟着对齐。Waffo 的周期只到日期（`T00:00:00Z`） |
| 状态事件 | `subscription.active`、`renewed`、`on_hold`、`past_due`、`failed`、`cancelled`、`expired`、`updated`、`plan_changed` | `subscription.activated`、`renewed`、`recovered`、`past_due`、`canceling`、`uncanceled`、`canceled` |
| 取消续费 | API 设 `cancel_at_next_billing_date` | API 取消：active 到当期结束才终止，past_due 立即终止 |
| 撤销取消 | API | 只能由买家在客户门户里操作（商户 API Key 调不了），账单页会引导去门户 |
| 客户门户 | 按订阅的客户 ID 现取地址 | 需要 `WAFFO_STORE_ID` |
| API 权限 | 运行时要 Subscriptions 写入（取消、撤销）、Customers 写入（门户），没有客户 ID 时还要 Subscriptions 读取 | 商户 API Key 即可 |

`scripts/dodo-setup.mjs` 和 `scripts/waffo-setup.mjs` 会为每个订阅套餐建商品，并把订阅事件加进 webhook 订阅列表。Dodo 的订阅商品 `subscription_period_count` 设为 10 年，也就是最多自动续费 10 年。

test 模式实测（2026-10-21，webhook 模式）：Waffo 月付首付、订阅激活、当月积分、门户地址、取消续费后回 `subscription.canceling` 全部通过；Dodo 首付、激活、积分和门户地址通过，取消续费因 test API Key 缺 Subscriptions 写入返回 403，还没验证。test 模式触发不了续费和扣款失败，这两条只由单元测试和 mock e2e 覆盖。

## webhook 返回码

支付商对非 2xx 响应会重试，返回码要按下表区分：

| 情形 | `status` | HTTP | 原因 |
| --- | --- | --- | --- |
| 正常入账、退款、标记失败 | `processed` | 200 | |
| 重复投递，或已被查单入账 | `duplicate` | 200 | |
| 不处理的事件类型、找不到订单的退款或失败事件、其他站点的订单 | `ignored` | 200 | 多个站可能共用一个商户号，不能让支付商对别站的事件无限重试 |
| 找不到订单的付款 | `orphan` | 200 | 不入账，触发“付款待核对”告警，人工处理 |
| 金额或商品对不上 | `mismatch` | 200 | 不入账，记下支付商流水号，触发告警。核实后在后台补单，或到支付商后台退款 |
| 退款先于付款到达，或数据库出错 | 抛错，事件记为 `failed` | 500 | 让支付商稍后重试，付款入账后这笔退款照常回收积分 |
| 签名错误 | — | 401 | |

`payment_events` 里已有 `failed` 记录的事件，重新投递时会再处理一次，其他状态的直接返回 `duplicate`。

## sandbox e2e

`tests/sandbox` 用支付商的 test 模式走真实收银台和测试卡，验证 mock 覆盖不到的部分：下单参数、收银台流程、回跳地址和查单入账。需要凭据和网络，结果受支付商影响，所以默认不进 CI，改支付商代码或发版前手动跑。

```bash
SANDBOX_PROVIDER=dodo E2E_PORT=3200 npm run test:sandbox
SANDBOX_PROVIDER=waffo E2E_PORT=3200 npm run test:sandbox
```

- 前提：`.dev.vars` 里有这家支付商的 test 凭据和 `*_PRODUCTS`（至少有 `starter`）。不用改 `PAYMENT_PROVIDER`：配置文件启动 dev server 时，用 `SANDBOX_PAYMENT_PROVIDER` 和 `SANDBOX_SITE_URL` 覆盖这两个变量（见 `vite.config.ts`），只对 dev server 生效。
- 端口：配置文件总是自己启动 dev server，端口被占用时直接报错，避免连到跑着 mock 的 server。默认 3000，被占用时用 `E2E_PORT` 换一个。
- 工件：报告、trace 和截图在 `.tmp/sandbox-e2e/<provider>/`。
- 没有公网隧道时，webhook 到不了本机，入账靠结果页第 15 秒的主动查单。用例会检查查单入账只发生一次、拒付不会被当成到账。
- 有隧道时设 `SANDBOX_WEBHOOK=1`：用例还会等 webhook 到达，检查 webhook 和查单只入账一次，并运行 Dodo 的部分退款用例和两家的订阅用例。准备步骤：
  1. `node scripts/webhook-proxy.mjs --port 3100 --target http://127.0.0.1:3200`，再用隧道（如 Pinggy）指向 3100。
  2. 把支付商后台的 test webhook 地址改成 `https://<隧道域名>/api/webhooks/<provider>`：`node scripts/dodo-setup.mjs --apply --webhook <url> --webhook-id <id>` 或 `node scripts/waffo-setup.mjs --store STO_xxx --apply --webhook <url> --webhook-id <id>`，签名密钥不变，也可以在后台修改。
  3. 跑完把 webhook 地址改回去，否则支付商会一直重试发往已失效的隧道。
- 订阅用例（仅 `SANDBOX_WEBHOOK=1`）：用月付走真实收银台，等 webhook 激活订阅，检查当月积分的到期时间等于当期结束、门户地址能打开，最后取消续费。Dodo 还会先取消再撤销，需要 key 有 Subscriptions 写入。中途失败时 test 订阅会一直续费，要在账单页或支付商后台手动取消。只跑订阅用例加 `--grep 订阅`，跳过加 `--grep-invert 订阅`。

测试卡与已知行为：

| | Dodo | Waffo |
| --- | --- | --- |
| 成功卡 | `4242 4242 4242 4242`，`06/32`，CVC `123` | `4576 7500 0000 0110`，`12/30`，CVC `123` |
| 拒付卡 | `4000 0000 0000 0002` | `4576 7500 0000 0220` |
| 回跳 | 成功或失败都跳回 `return_url` | 付款成功后停在 Waffo 结果页（订阅显示 “Subscription successful”），点 Done 才跳回；拒付停在 Waffo 失败页，不跳回 |
| 拒付后的订单 | 有 webhook 时转 failed，没有时保持 pending | 保持 pending（本站不处理 Waffo 的失败事件） |
| 退款 | 用例退 330 美分。从商户钱包扣，付款后约 4–5 分钟才入账，余额不足时返回 409，用例会跳过，稍后重跑 | 不进用例：异步（实测 12–22 分钟），每笔支付只能退一次 |

收银台是第三方页面，改版后选择器会失效。失败时先看 trace 和截图，再改 `tests/sandbox/<provider>.spec.ts` 里的付款函数。

## 新增一个支付商

以 `foo` 为例：

1. `src/server/payments/foo.ts`：实现 `createFooProvider(env)`、`verifyFooWebhook`、`normalizeFooEvent`。参考 `dodo.ts`（使用 Standard Webhooks 规范）或 `waffo.ts`（RSA 签名，用 GraphQL 查单）。
2. `src/server/payments/types.ts`：在 `PaymentProviderId` 里加 `'foo'`。
3. `src/server/payments/index.ts`：在 `activePaymentProviderId`、`getOrderProvider`、`getPaymentProvider` 里都加上分支。漏掉 `getOrderProvider` 的话，切换支付商后旧订单就不能退款和查单了。
4. `src/server/app.ts`：添加 `POST /api/webhooks/foo`。先用 `c.req.text()` 读原始请求体并验签，再调用 `processPaymentEvent(c.env, 'foo', normalizeFooEvent(payload), raw)`。`/api/webhooks/*` 已经豁免了 CSRF 同源校验。
5. `src/server/orders.ts`：在 `expectedProductId` 里加上 `FOO_PRODUCTS`；支持退款的话，在 `REFUND_WINDOW_DAYS` 里写上支付商规定的退款期限。
6. 环境变量：添加 `FOO_ENVIRONMENT`、`FOO_PRODUCTS` 和 secret，步骤见 [env.md](env.md) 的“新增变量”。在 `src/server/config-health.ts` 的 `PAYMENT_SECRETS` 里登记 secret，并补上判断 test/live 模式的规则。
7. 后台：在 `src/routes/admin/orders.index.tsx` 的支付商筛选里加一项。
8. 测试：
   - 单元测试，参考 `tests/unit/dodo.test.ts`：正确签名、篡改请求体、过期时间戳、test/live 模式不符，以及各事件类型的映射（含部分退款和折扣）。
   - 冒烟巡检：在 `tests/smoke/production.spec.ts` 里把 `/api/webhooks/foo` 加进未签名回调返回 401 的列表。
   - e2e 的支付与退款场景用的是 mock 支付商，与具体支付商无关，不用重复写。
   - sandbox e2e：照 `tests/sandbox/dodo.spec.ts` 写 `foo.spec.ts`（成功卡入账一次、拒付不入账），在 `playwright.sandbox.config.ts` 的 `SANDBOX_PROVIDER` 白名单里加上 `foo`，并登记到 `tests/e2e/CATALOG.md`。
9. 订阅（可选）：在 `normalizeFooEvent` 里给订阅扣款填 `subscription`、把订阅状态事件映射成 `kind: 'subscription'`，实现 `cancelSubscription` 和 `portalUrl`（能由商户撤销取消的再实现 `resumeSubscription`），setup 脚本里为 `sellingPlans`（开关打开时的 `site.plans`）建订阅商品，并补上映射的单元测试。
10. 文档：在 README 两份的“第三方回调地址”表里加上回调地址和实测行为，在 ROADMAP 里记录哪些已经用 test 模式验证过。


## Stripe（积分包 Checkout + 订阅）

与 ShipAny 站点同一套路：Stripe Checkout Session → webhook 入账 → 积分流水幂等。

1. Dashboard 为每个 `site.packages[].id` / `site.plans[].id` 建 Product + Price，把 **Price ID**（`price_…`）写进 `STRIPE_PRODUCTS`。
2. `PAYMENT_PROVIDER=stripe`，`STRIPE_ENVIRONMENT=test|live`，secret 写入 `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`。
3. Webhook 端点：`https://<domain>/api/webhooks/stripe`，至少订阅：
   - `checkout.session.completed`
   - `invoice.payment_succeeded` / `invoice.paid`（续费）
   - `invoice.payment_failed`
   - `checkout.session.expired`
   - `charge.refunded`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. 实现见 `src/server/payments/stripe.ts`（Workers 上用 fetch + SubtleCrypto 验签，不依赖 `stripe` npm）。
5. 退款窗口按 Stripe 常见政策记为 90 天（`REFUND_WINDOW_DAYS.stripe`）；实际以你的 Stripe 账户与当地法规为准。

注意：Stripe 不是 Merchant of Record，税费/发票/合规由商户自行处理；若需要 MoR，继续用 Waffo / Dodo。
