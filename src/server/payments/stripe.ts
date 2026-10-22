// Stripe Checkout + Webhooks（非 Merchant of Record；税费/发票由 Stripe Tax / 商户自行处理）。
// 与 ShipAny 站点一致：Checkout Session 买积分包/订阅，webhook 入账，积分流水幂等。
// 不用 stripe npm：Workers 上用 fetch + SubtleCrypto 验签即可。
// 文档：https://docs.stripe.com/checkout/quickstart
//       https://docs.stripe.com/webhooks
import { findPlan, site } from '#/config/site'
import { ApiError, cleanSecret, constantTimeEqual, hmacSha256, parseJsonRecord } from '../util'
import { minorToDisplay } from './amount'
import type {
  CheckoutInput,
  CheckoutResult,
  PaidLookup,
  PaymentEvent,
  PaymentProvider,
  RefundRequest,
  RefundRequestResult,
  SubscriptionCharge,
  SubscriptionRef,
  SubscriptionStatus,
} from './types'
import { WebhookVerificationError } from './types'

const API = 'https://api.stripe.com/v1'
const TOLERANCE_SECONDS = 5 * 60

export function createStripeProvider(env: Env): PaymentProvider {
  const secret = cleanSecret(env.STRIPE_SECRET_KEY)
  const prices = parseJsonRecord(env.STRIPE_PRODUCTS)

  const call = async (method: string, path: string, body?: Record<string, string | number | boolean | null | undefined>) => {
    if (!secret) throw new ApiError(503, 'payment_not_configured', 'STRIPE_SECRET_KEY missing')
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: body ? encodeForm(body) : undefined,
    })
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) {
      const message = stripeErrorMessage(json)
      if (response.status === 400 || response.status === 404 || response.status === 409) {
        throw new ApiError(409, 'payment_provider_conflict', `Stripe ${method} ${path}: ${message}`.trim())
      }
      throw new ApiError(502, 'payment_provider_error', `Stripe ${method} ${path}: ${message}`.trim())
    }
    return json ?? {}
  }

  return {
    id: 'stripe',
    async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
      if (!secret) throw new ApiError(503, 'payment_not_configured', 'STRIPE_SECRET_KEY missing')
      const priceId = prices[input.order.packageId]
      if (!priceId) throw new ApiError(503, 'payment_not_configured', `No Stripe price for ${input.order.packageId}`)
      const plan = findPlan(input.order.packageId)
      const mode = plan ? 'subscription' : 'payment'
      const form: Record<string, string | number | boolean | null | undefined> = {
        mode,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        customer_email: input.user.email,
        client_reference_id: input.order.id,
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': 1,
        'metadata[orderId]': input.order.id,
        'metadata[userId]': input.user.id,
        'metadata[packageId]': input.order.packageId,
        'metadata[site]': site.domain,
        'payment_intent_data[metadata][orderId]': mode === 'payment' ? input.order.id : undefined,
        'payment_intent_data[metadata][packageId]': mode === 'payment' ? input.order.packageId : undefined,
        'payment_intent_data[metadata][site]': mode === 'payment' ? site.domain : undefined,
        'subscription_data[metadata][orderId]': mode === 'subscription' ? input.order.id : undefined,
        'subscription_data[metadata][packageId]': mode === 'subscription' ? input.order.packageId : undefined,
        'subscription_data[metadata][site]': mode === 'subscription' ? site.domain : undefined,
        'subscription_data[metadata][userId]': mode === 'subscription' ? input.user.id : undefined,
      }
      const session = await call('POST', '/checkout/sessions', form)
      const url = str(session.url)
      const id = str(session.id)
      if (!url || !id) throw new ApiError(502, 'payment_provider_error', 'Stripe checkout returned no url')
      return { url, sessionId: id }
    },

    async refund(input: RefundRequest): Promise<RefundRequestResult> {
      const form: Record<string, string | number | boolean | null | undefined> = {
        payment_intent: input.providerPaymentId,
        reason: 'requested_by_customer',
        'metadata[orderId]': input.orderId,
      }
      if (!input.fullAmount) form.amount = input.amountCents
      const body = await call('POST', '/refunds', form)
      return { refundId: str(body.id), status: str(body.status) ?? 'pending' }
    },

    async fetchPaidEvent(order): Promise<PaidLookup | null> {
      if (!secret || !order.providerSessionId) return null
      const session = await call('GET', `/checkout/sessions/${encodeURIComponent(order.providerSessionId)}`)
      if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') return null
      const event = normalizeStripeEvent({
        id: `reconcile:${str(session.id) ?? order.providerSessionId}`,
        type: 'checkout.session.completed',
        data: { object: session },
      })
      return event.kind === 'paid' ? { event: { ...event, eventType: 'reconcile' }, raw: session } : null
    },

    async cancelSubscription(subscription: SubscriptionRef) {
      await call('POST', `/subscriptions/${encodeURIComponent(subscription.providerSubscriptionId)}`, { cancel_at_period_end: true })
    },

    async resumeSubscription(subscription: SubscriptionRef) {
      await call('POST', `/subscriptions/${encodeURIComponent(subscription.providerSubscriptionId)}`, { cancel_at_period_end: false })
    },

    async portalUrl(subscription: SubscriptionRef, returnUrl: string) {
      if (!subscription.providerCustomerId) throw new ApiError(502, 'payment_provider_error', 'Stripe subscription has no customer')
      const session = await call('POST', '/billing_portal/sessions', {
        customer: subscription.providerCustomerId,
        return_url: returnUrl,
      })
      const url = str(session.url)
      if (!url) throw new ApiError(502, 'payment_provider_error', 'Stripe portal returned no url')
      return url
    },
  }
}

export async function verifyStripeWebhook(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string | undefined,
  nowMs = Date.now(),
): Promise<Record<string, unknown>> {
  const cleaned = cleanSecret(secret)
  if (!cleaned) throw new WebhookVerificationError('STRIPE_WEBHOOK_SECRET missing')
  if (!signatureHeader) throw new WebhookVerificationError('missing stripe-signature header')
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((part) => {
      const [k, ...rest] = part.split('=')
      return [k?.trim() ?? '', rest.join('=').trim()]
    }),
  )
  const timestamp = Number(parts.t)
  if (!Number.isFinite(timestamp)) throw new WebhookVerificationError('missing timestamp')
  const age = Math.floor(nowMs / 1000) - timestamp
  if (Math.abs(age) > TOLERANCE_SECONDS) throw new WebhookVerificationError('timestamp outside tolerance')
  const signed = `${timestamp}.${rawBody}`
  const expected = hex(await hmacSha256(cleaned, signed))
  const candidates = signatureHeader
    .split(',')
    .filter((part) => part.trim().startsWith('v1='))
    .map((part) => part.trim().slice(3))
  if (!candidates.some((sig) => constantTimeEqual(sig, expected))) throw new WebhookVerificationError('invalid signature')
  return JSON.parse(rawBody) as Record<string, unknown>
}

export function normalizeStripeEvent(payload: Record<string, unknown>): PaymentEvent {
  const eventType = String(payload.type ?? '')
  const eventId = String(payload.id ?? '')
  const data = record(record(payload.data).object)

  switch (eventType) {
    case 'checkout.session.completed': {
      const paymentStatus = str(data.payment_status)
      if (paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
        return { kind: 'ignored', eventId, eventType }
      }
      const metadata = record(data.metadata)
      const cents = int(data.amount_total)
      const currency = str(data.currency)?.toUpperCase() ?? null
      const subscriptionId = str(data.subscription)
      return {
        kind: 'paid',
        eventId,
        eventType,
        orderId: str(metadata.orderId) ?? str(data.client_reference_id),
        providerOrderId: str(data.id),
        providerPaymentId: str(data.payment_intent) ?? str(data.invoice) ?? str(data.id),
        paidAmount: cents !== null && currency ? minorToDisplay(cents, currency) : null,
        paidCurrency: currency,
        paidAmountCents: cents,
        productId: null,
        packageId: str(metadata.packageId),
        discounted: int(record(data.total_details).amount_discount) !== null && (int(record(data.total_details).amount_discount) ?? 0) > 0,
        site: str(metadata.site),
        subscription: subscriptionId
          ? ({
              providerSubscriptionId: subscriptionId,
              providerCustomerId: str(data.customer),
            } satisfies SubscriptionCharge)
          : null,
      }
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      // 首单已由 checkout.session.completed 入账；续费只处理 subscription_cycle / subscription_update
      const reason = str(data.billing_reason)
      if (reason === 'subscription_create') return { kind: 'ignored', eventId, eventType }
      const subscriptionId = str(data.subscription)
      if (!subscriptionId) return { kind: 'ignored', eventId, eventType }
      if (reason && reason !== 'subscription_cycle' && reason !== 'subscription_update') {
        return { kind: 'ignored', eventId, eventType }
      }
      const metadata = {
        ...record(data.metadata),
        ...record(record(data.subscription_details).metadata),
      }
      const lineData = Array.isArray(record(data.lines).data) ? (record(data.lines).data as unknown[]) : []
      const firstLine = record(lineData[0] as Record<string, unknown> | undefined)
      const period = record(firstLine.period)
      const cents = int(data.amount_paid) ?? int(data.total)
      const currency = str(data.currency)?.toUpperCase() ?? null
      const priceId =
        str(record(firstLine.price).id) ??
        str(record(record(firstLine.pricing).price_details).price)
      return {
        kind: 'paid',
        eventId,
        eventType,
        orderId: str(metadata.orderId),
        providerOrderId: str(data.id),
        providerPaymentId: str(data.payment_intent) ?? str(data.id),
        paidAmount: cents !== null && currency ? minorToDisplay(cents, currency) : null,
        paidCurrency: currency,
        paidAmountCents: cents,
        productId: priceId,
        packageId: str(metadata.packageId),
        discounted: false,
        site: str(metadata.site),
        subscription: {
          providerSubscriptionId: subscriptionId,
          providerCustomerId: str(data.customer),
          periodStart: unixToIso(period.start),
          periodEnd: unixToIso(period.end),
        },
      }
    }
    case 'checkout.session.expired':
    case 'invoice.payment_failed':
      return {
        kind: 'failed',
        eventId,
        eventType,
        orderId: str(record(data.metadata).orderId) ?? str(data.client_reference_id),
      }
    case 'charge.refunded': {
      const refunds = record(data.refunds)
      const list = Array.isArray(refunds.data) ? (refunds.data as unknown[]) : []
      const latest = record(list[0] as Record<string, unknown> | undefined)
      const refundAmount = int(latest.amount) ?? int(data.amount_refunded)
      const original = int(data.amount)
      return {
        kind: 'refunded',
        eventId,
        eventType,
        orderId: str(record(data.metadata).orderId) ?? str(record(latest.metadata).orderId),
        providerPaymentId: str(data.payment_intent) ?? str(data.id),
        refundId: str(latest.id) ?? str(data.id),
        refundAmountCents: original !== null && refundAmount !== null && refundAmount < original ? refundAmount : null,
        originalAmountCents: original,
      }
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscriptionId = str(data.id)
      if (!subscriptionId) return { kind: 'ignored', eventId, eventType }
      const metadata = record(data.metadata)
      const items = record(data.items)
      const itemList = Array.isArray(items.data) ? (items.data as unknown[]) : []
      const priceId = str(record(record(itemList[0] as Record<string, unknown> | undefined).price).id)
      return {
        kind: 'subscription',
        eventId,
        eventType,
        orderId: str(metadata.orderId),
        providerSubscriptionId: subscriptionId,
        status: STRIPE_STATUS[String(data.status)] ?? (eventType === 'customer.subscription.deleted' ? 'canceled' : null),
        cancelAtPeriodEnd: typeof data.cancel_at_period_end === 'boolean' ? data.cancel_at_period_end : null,
        periodStart: unixToIso(data.current_period_start),
        periodEnd: unixToIso(data.current_period_end),
        providerCustomerId: str(data.customer),
        productId: priceId,
        planId: str(metadata.packageId),
        occurredAt: unixToIso(payload.created) ?? nowFallback(),
        site: str(metadata.site),
      }
    }
    default:
      return { kind: 'ignored', eventId, eventType }
  }
}

const STRIPE_STATUS: Record<string, SubscriptionStatus> = {
  active: 'active',
  trialing: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'canceled',
  incomplete_expired: 'expired',
  paused: 'expired',
}

function encodeForm(body: Record<string, string | number | boolean | null | undefined>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null || value === '') continue
    params.append(key, String(value))
  }
  return params.toString()
}

function stripeErrorMessage(json: Record<string, unknown> | null) {
  const err = record(json?.error)
  return typeof err.message === 'string' ? err.message : typeof json?.message === 'string' ? json.message : 'request failed'
}

function hex(bytes: Uint8Array) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function int(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Math.round(Number(value))
  return null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function unixToIso(value: unknown): string | null {
  const n = int(value)
  return n === null ? null : new Date(n * 1000).toISOString()
}

function nowFallback() {
  return new Date().toISOString()
}
