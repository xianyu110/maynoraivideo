import { Link, createFileRoute } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { AdminPage, FilterSelect, LoadState, PAGE_SIZE, Pager, Status, money, shortDate, useAdminData } from '#/components/admin'
import { OrderActions, orderStatus, type AdminOrder } from '#/components/admin-orders'

export const Route = createFileRoute('/admin/orders/')({
  component: AdminOrders,
})

function AdminOrders() {
  const [status, setStatus] = useState('')
  const [provider, setProvider] = useState('')
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const params = new URLSearchParams({ page: String(page) })
  if (status) params.set('status', status)
  if (provider) params.set('provider', provider)
  if (q) params.set('q', q)
  const { data, error, loading, reload } = useAdminData<{ orders: AdminOrder[] }>(`/api/admin/orders?${params}`)
  const orders = data?.orders ?? []

  function search(event: FormEvent) {
    event.preventDefault()
    setPage(1)
    setQ(input.trim())
  }

  return (
    <AdminPage title="订单">
      <div className="flex flex-wrap items-center gap-4">
        <FilterSelect
          label="状态"
          value={status}
          onChange={(v) => {
            setStatus(v)
            setPage(1)
          }}
          options={[
            ['', '全部'],
            ['paid', '已支付'],
            ['pending', '待支付'],
            ['failed', '失败'],
            ['refunded', '已退款'],
            ['canceled', '已取消'],
          ]}
        />
        <FilterSelect
          label="支付商"
          value={provider}
          onChange={(v) => {
            setProvider(v)
            setPage(1)
          }}
          options={[
            ['', '全部'],
            ['waffo', 'Waffo'],
            ['dodo', 'Dodo Payments'],
            ['stripe', 'Stripe'],
            ['mock', 'Mock'],
          ]}
        />
        <form onSubmit={search} className="flex gap-2">
          <input className="input w-72 py-1.5" placeholder="订单号 / 邮箱 / 支付商流水号" value={input} onChange={(e) => setInput(e.target.value)} />
          <button type="submit" className="btn-primary px-4 py-1.5">
            搜索
          </button>
        </form>
      </div>
      <LoadState loading={loading && !data} error={error} empty={!!data && !orders.length} />
      {orders.length ? (
        <div className="card overflow-x-auto">
          <table className="table-admin" data-testid="admin-orders">
            <thead>
              <tr>
                <th>订单号</th>
                <th>用户</th>
                <th>支付商</th>
                <th>套餐</th>
                <th>金额</th>
                <th>状态</th>
                <th>来源</th>
                <th>创建 / 支付</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td className="font-mono text-xs">
                    <Link to="/admin/orders/$id" params={{ id: o.id }} className="hover:underline" data-testid={`order-link-${o.id}`}>
                      {o.id}
                    </Link>
                    {o.provider_payment_id ? <span className="block text-muted">{o.provider_payment_id}</span> : null}
                  </td>
                  <td>
                    <Link to="/admin/users/$id" params={{ id: o.user_id }} className="hover:underline">
                      {o.user_email}
                    </Link>
                  </td>
                  <td>{o.provider}</td>
                  <td>
                    {o.package_id} · {o.credits}
                  </td>
                  <td>
                    {money(o.amount_cents, o.currency)}
                    {o.paid_amount && o.paid_currency && o.paid_currency !== o.currency ? (
                      <span className="block text-xs text-muted">
                        实付 {o.paid_amount} {o.paid_currency}
                      </span>
                    ) : null}
                    {o.refunded_amount_cents > 0 ? (
                      <span className="block text-xs text-muted">
                        已退 {money(o.refunded_amount_cents, o.paid_currency ?? o.currency)} · {o.refunded_credits} 积分
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <Status value={orderStatus(o)} />
                  </td>
                  <td className="text-xs">
                    {o.source ? `${o.source} / ${o.medium ?? '-'}` : '-'}
                    <span className="block text-muted">
                      {[o.campaign, o.country, o.device].filter(Boolean).join(' · ') || null}
                    </span>
                  </td>
                  <td className="whitespace-nowrap text-xs">
                    {shortDate(o.created_at)}
                    <span className="block text-muted">{shortDate(o.paid_at)}</span>
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <OrderActions order={o} onDone={reload} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <Pager page={page} onPage={setPage} hasMore={orders.length === PAGE_SIZE} />
    </AdminPage>
  )
}
