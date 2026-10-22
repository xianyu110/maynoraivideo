import { createHmac, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStripeProvider, normalizeStripeEvent, verifyStripeWebhook } from '#/server/payments/stripe'

const NOW = Date.UTC(2026, 9, 20, 8, 0, 0)
const SECRET = `whsec_${randomBytes(24).toString('hex')}`

function sign(timestamp: number, body: string, secret = SECRET) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

describe('verifyStripeWebhook', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } })
  const ts = Math.floor(NOW / 1000)

  it('接受正确签名', async () => {
    const payload = await verifyStripeWebhook(body, `t=${ts},v1=${sign(ts, body)}`, SECRET, NOW)
    expect(payload.id).toBe('evt_1')
  })

  it('拒绝篡改 body、过期时间戳、缺密钥', async () => {
    await expect(verifyStripeWebhook(body.replace('evt_1', 'evt_2'), `t=${ts},v1=${sign(ts, body)}`, SECRET, NOW)).rejects.toThrow(
      'invalid signature',
    )
    await expect(verifyStripeWebhook(body, `t=${ts - 600},v1=${sign(ts - 600, body)}`, SECRET, NOW)).rejects.toThrow('timestamp')
    await expect(verifyStripeWebhook(body, `t=${ts},v1=${sign(ts, body)}`, '  ', NOW)).rejects.toThrow('STRIPE_WEBHOOK_SECRET missing')
  })
})

describe('normalizeStripeEvent', () => {
  it('checkout.session.completed → paid（积分包）', () => {
    const paid = normalizeStripeEvent({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          payment_status: 'paid',
          payment_intent: 'pi_1',
          amount_total: 990,
          currency: 'usd',
          client_reference_id: 'ord_1',
          metadata: { orderId: 'ord_1', packageId: 'starter', site: 'example.com' },
          total_details: { amount_discount: 0 },
        },
      },
    })
    expect(paid).toMatchObject({
      kind: 'paid',
      eventId: 'evt_1',
      orderId: 'ord_1',
      providerPaymentId: 'pi_1',
      providerOrderId: 'cs_1',
      paidAmountCents: 990,
      paidAmount: '9.90',
      packageId: 'starter',
      site: 'example.com',
      subscription: null,
    })
  })

  it('checkout.session.completed 带 subscription → paid + subscription charge', () => {
    const paid = normalizeStripeEvent({
      id: 'evt_2',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_2',
          payment_status: 'paid',
          payment_intent: 'pi_2',
          subscription: 'sub_1',
          customer: 'cus_1',
          amount_total: 1490,
          currency: 'usd',
          metadata: { orderId: 'ord_2', packageId: 'monthly' },
        },
      },
    })
    expect(paid).toMatchObject({
      kind: 'paid',
      subscription: { providerSubscriptionId: 'sub_1', providerCustomerId: 'cus_1' },
    })
  })

  it('invoice.payment_succeeded 续费 → paid；首单忽略', () => {
    expect(
      normalizeStripeEvent({
        id: 'evt_3',
        type: 'invoice.payment_succeeded',
        data: { object: { billing_reason: 'subscription_create', subscription: 'sub_1' } },
      }).kind,
    ).toBe('ignored')
    const renew = normalizeStripeEvent({
      id: 'evt_4',
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: 'in_1',
          billing_reason: 'subscription_cycle',
          subscription: 'sub_1',
          customer: 'cus_1',
          payment_intent: 'pi_3',
          amount_paid: 1490,
          currency: 'usd',
          metadata: { packageId: 'monthly', site: 'example.com' },
          lines: { data: [{ period: { start: 1_700_000_000, end: 1_702_592_000 }, price: { id: 'price_m' } }] },
        },
      },
    })
    expect(renew).toMatchObject({
      kind: 'paid',
      providerPaymentId: 'pi_3',
      productId: 'price_m',
      paidAmountCents: 1490,
      subscription: { providerSubscriptionId: 'sub_1', providerCustomerId: 'cus_1' },
    })
  })

  it('charge.refunded / subscription 状态 / expired', () => {
    expect(
      normalizeStripeEvent({
        id: 'evt_5',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_1',
            payment_intent: 'pi_1',
            amount: 990,
            amount_refunded: 990,
            refunds: { data: [{ id: 're_1', amount: 990, metadata: { orderId: 'ord_1' } }] },
          },
        },
      }),
    ).toMatchObject({ kind: 'refunded', refundId: 're_1', providerPaymentId: 'pi_1', refundAmountCents: null })
    expect(
      normalizeStripeEvent({
        id: 'evt_6',
        type: 'customer.subscription.updated',
        created: 1_700_000_000,
        data: {
          object: {
            id: 'sub_1',
            status: 'active',
            cancel_at_period_end: true,
            current_period_start: 1_700_000_000,
            current_period_end: 1_702_592_000,
            customer: 'cus_1',
            metadata: { orderId: 'ord_2', packageId: 'monthly', site: 'example.com' },
            items: { data: [{ price: { id: 'price_m' } }] },
          },
        },
      }),
    ).toMatchObject({ kind: 'subscription', status: 'active', cancelAtPeriodEnd: true, planId: 'monthly' })
    expect(normalizeStripeEvent({ id: 'evt_7', type: 'checkout.session.expired', data: { object: { metadata: { orderId: 'ord_1' } } } }).kind).toBe(
      'failed',
    )
  })
})

describe('createStripeProvider.fetchPaidEvent', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('session paid 时按 checkout.session.completed 规则归一化', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      expect(String(url)).toContain('/checkout/sessions/cs_1')
      return new Response(
        JSON.stringify({
          id: 'cs_1',
          payment_status: 'paid',
          payment_intent: 'pi_1',
          amount_total: 990,
          currency: 'usd',
          metadata: { orderId: 'ord_1', packageId: 'starter' },
        }),
        { status: 200 },
      )
    })
    const provider = createStripeProvider({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRODUCTS: '{}' } as unknown as Env)
    const result = await provider.fetchPaidEvent!({ id: 'ord_1', packageId: 'starter', providerSessionId: 'cs_1' })
    expect(result?.event).toMatchObject({ kind: 'paid', orderId: 'ord_1', providerPaymentId: 'pi_1', eventType: 'reconcile' })
  })
})
