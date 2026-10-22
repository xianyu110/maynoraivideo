import { afterEach, describe, expect, it, vi } from 'vitest'
import { site } from '#/config/site'
import { createTryAllApiProvider } from '#/server/video/tryallapi'

const env = (vars: Record<string, string> = {}) =>
  ({
    APP_ENV: 'production',
    SITE_URL: 'https://moonhop.ai',
    SESSION_SECRET: 'a'.repeat(64),
    TRYALLAPI_API_KEY: 'sk-tryall',
    ...vars,
  }) as unknown as Env

const input = (webhookUrl = 'https://moonhop.ai/api/webhooks/tryallapi?gen=gen_1&token=t') => ({
  generationId: 'gen_1',
  durationSeconds: 12,
  imageUrl: 'https://moonhop.ai/media/uploads/upl_1?exp=1&sig=s',
  sourceVideoUrl: 'https://moonhop.ai/media/templates/neon-12s.mp4',
  sourceVideoKey: 'templates/neon-12s.mp4',
  webhookUrl,
  meta: {},
})

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('tryallapi provider', () => {
  it('提交时带上模型、照片、时长，HTTPS 才附带 webhook', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return json(200, { task_id: 'task_1', status: 'queued' })
    })
    const provider = createTryAllApiProvider(env())
    expect(await provider.submit(input())).toEqual({ requestId: 'task_1', meta: { base: 'https://tryallapi.com' } })
    expect(calls[0]!.url).toBe('https://tryallapi.com/v1/video/generations')
    expect(calls[0]!.body).toMatchObject({
      model: site.video.tryallapi.model,
      prompt: site.video.tryallapi.prompt,
      image: input().imageUrl,
      duration: 12,
      webhook_url: input().webhookUrl,
    })

    await provider.submit(input('http://localhost:3000/api/webhooks/tryallapi?gen=gen_1&token=t'))
    expect(calls[1]!.body).not.toHaveProperty('webhook_url')
  })

  it('status：排队中 / 成功出片 / 失败', async () => {
    const responses = [
      json(200, { status: 'in_progress' }),
      json(200, { status: 'completed', video_url: 'https://cdn.example/out.mp4' }),
      json(200, { status: 'failed', error: { message: 'no channel' } }),
    ]
    vi.stubGlobal('fetch', async () => responses.shift()!)
    const provider = createTryAllApiProvider(env())
    expect(await provider.status('task_1', { base: 'https://tryallapi.com' })).toEqual({ state: 'pending' })
    expect(await provider.status('task_1', { base: 'https://tryallapi.com' })).toEqual({
      state: 'completed',
      output: { url: 'https://cdn.example/out.mp4' },
    })
    expect(await provider.status('task_1', { base: 'https://tryallapi.com' })).toMatchObject({
      state: 'failed',
      code: 'tryallapi_failed',
      message: expect.stringContaining('no channel'),
    })
  })

  it('自定义 BASE_URL；缺密钥不可重试', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      expect(String(url).startsWith('https://custom.example/v1/')).toBe(true)
      return json(200, { id: 'task_x', status: 'queued' })
    })
    const provider = createTryAllApiProvider(env({ TRYALLAPI_BASE_URL: 'https://custom.example/' }))
    expect((await provider.submit(input())).requestId).toBe('task_x')
    await expect(createTryAllApiProvider(env({ TRYALLAPI_API_KEY: '' })).submit(input())).rejects.toMatchObject({
      code: 'provider_not_configured',
      retryable: false,
    })
  })
})
