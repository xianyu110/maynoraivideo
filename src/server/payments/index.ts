import { ApiError, isProduction } from '../util'
import { createDodoProvider } from './dodo'
import { createStripeProvider } from './stripe'
import type { PaidEvent, PaymentProvider, PaymentProviderId } from './types'
import { createWaffoProvider } from './waffo'

// mock：本地与 e2e 用，跳转到站内 /checkout/mock 页面模拟付款（生产环境禁止）
// 与 successUrl 保持同一语言前缀（/zh/checkout/success → /zh/checkout/mock）
function createMockProvider(env: Env): PaymentProvider {
  return {
    id: 'mock',
    async createCheckout(input) {
      const url = new URL(input.successUrl)
      url.pathname = url.pathname.replace(/\/checkout\/success$/, '/checkout/mock')
      url.search = ''
      url.searchParams.set('order', input.order.id)
      return { url: `${url.pathname}${url.search}`, sessionId: `mock_${input.order.id}` }
    },
    // “支付商那边已付款”的状态由 /api/mock-payments/complete（deliver: false）写入 KV，模拟 webhook 丢失
    async fetchPaidEvent(order) {
      const event = await env.KV.get<PaidEvent>(mockPaidKey(order.id), 'json')
      return event ? { event, raw: event } : null
    },
    // 订阅：取消、恢复直接成功（状态变化由 /api/mock-payments/subscription 模拟 webhook），门户回到账单页
    async cancelSubscription() {},
    async resumeSubscription() {},
    // 和 createCheckout 一样只返回 path：本地 SITE_URL 的端口不一定是 dev server 的端口
    async portalUrl(_subscription, returnUrl) {
      return `${new URL(returnUrl).pathname}#mock-portal`
    },
  }
}

export function mockPaidKey(orderId: string) {
  return `mock_paid:${orderId}`
}

export function activePaymentProviderId(env: Env): PaymentProviderId {
  const id = env.PAYMENT_PROVIDER as PaymentProviderId
  if (id === 'waffo' || id === 'dodo' || id === 'stripe') return id
  if (id === 'mock' && !isProduction(env)) return 'mock'
  throw new ApiError(503, 'payment_not_configured', `Unsupported PAYMENT_PROVIDER: ${env.PAYMENT_PROVIDER}`)
}

// 退款、查单按订单所属支付商走（切换 PAYMENT_PROVIDER 后，旧订单仍找原支付商）；生产环境不认 mock 订单
export function getOrderProvider(env: Env, id: string): PaymentProvider | null {
  if (id === 'waffo') return createWaffoProvider(env)
  if (id === 'dodo') return createDodoProvider(env)
  if (id === 'stripe') return createStripeProvider(env)
  if (id === 'mock' && !isProduction(env)) return createMockProvider(env)
  return null
}

export function getPaymentProvider(env: Env): PaymentProvider {
  const id = activePaymentProviderId(env)
  if (id === 'waffo') return createWaffoProvider(env)
  if (id === 'dodo') return createDodoProvider(env)
  if (id === 'stripe') return createStripeProvider(env)
  return createMockProvider(env)
}
