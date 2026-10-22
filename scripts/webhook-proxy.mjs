// 本地联调支付 webhook 用的白名单反向代理：只转发 POST /api/webhooks/{waffo,dodo,stripe}，其余一律 404。
// 把隧道（cloudflared / ssh -R）指向这个端口，而不是直接暴露 dev server（dev 登录、mock 支付、后台都不会被公网访问到）。
//   node scripts/webhook-proxy.mjs [--port 3100] [--target http://127.0.0.1:3000]
import { createServer, request } from 'node:http'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const port = Number(arg('port', '3100'))
const target = new URL(arg('target', 'http://127.0.0.1:3000'))
const ALLOWED = /^\/api\/webhooks\/(waffo|dodo|stripe)$/
const MAX_BODY = 1024 * 1024
// 只透传签名校验需要的头，避免把隧道侧的 X-Forwarded-* / Host 带进来
const PASS_HEADERS = ['content-type', 'user-agent', 'x-waffo-signature', 'webhook-id', 'webhook-timestamp', 'webhook-signature', 'stripe-signature']

const log = (...parts) => console.log(new Date().toISOString(), ...parts)

createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]
  if (req.method !== 'POST' || !ALLOWED.test(path)) {
    log('reject', req.method, path)
    res.writeHead(404).end()
    req.resume()
    return
  }
  const chunks = []
  let size = 0
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BODY) {
      res.writeHead(413).end()
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    if (res.writableEnded) return
    const body = Buffer.concat(chunks)
    const headers = { host: target.host, 'content-length': String(body.length) }
    for (const name of PASS_HEADERS) if (req.headers[name]) headers[name] = req.headers[name]
    // 记录事件类型与是否带签名，方便区分"支付商真实回调"和"公网扫描/探测"（不记录 body，避免泄露客户信息）
    let event = '-'
    try {
      const json = JSON.parse(body.toString('utf8'))
      event = `${json.eventType ?? json.type ?? '?'}#${json.id ?? json.eventId ?? json.data?.payment_id ?? '?'}`
    } catch {
      event = 'non-json'
    }
    const signed = Boolean(headers['x-waffo-signature'] || headers['webhook-signature'])
    log('recv', path, event, `signed=${signed}`, `ua=${String(req.headers['user-agent'] ?? '-').slice(0, 60)}`)
    const upstream = request(
      { hostname: target.hostname, port: target.port, path, method: 'POST', headers },
      (upRes) => {
        const out = []
        upRes.on('data', (c) => out.push(c))
        upRes.on('end', () => {
          const text = Buffer.concat(out).toString('utf8')
          log('forward', path, upRes.statusCode, text.slice(0, 300))
          res.writeHead(upRes.statusCode ?? 502, { 'content-type': upRes.headers['content-type'] ?? 'application/json' }).end(text)
        })
      },
    )
    upstream.on('error', (error) => {
      log('upstream error', path, error.message)
      res.writeHead(502).end()
    })
    upstream.end(body)
  })
}).listen(port, '127.0.0.1', () => log(`webhook proxy :${port} → ${target.origin} (only POST /api/webhooks/waffo|dodo)`))
