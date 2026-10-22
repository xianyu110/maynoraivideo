// TryAllAPI / momoAPIPro（OpenAI 兼容聚合）：https://tryallapi.com
// 视频走 NewAPI 风格异步任务：POST /v1/video/generations → 轮询 GET /v1/video/generations/{id}
// （部分部署也提供 /v1/video/tasks/{id}，status 里会回退尝试）
// ShrimpReel 是「用户照片 + 模板动作」成片：默认把照片作 image，模板源视频 URL 放进 metadata，
// prompt 说明要保留人物并跟练模板动作。具体模型对 image / video 参考的支持以控制台为准。
import { site } from '#/config/site'
import { cleanSecret } from '../util'
import type { VideoProvider, VideoStatus } from './types'
import { VideoProviderError } from './types'

const DEFAULT_BASE = 'https://tryallapi.com'

interface TryAllTask {
  id?: string
  task_id?: string
  status?: string
  progress?: number
  video_url?: string
  url?: string
  output?: { url?: string; video_url?: string } | string
  data?: { output?: string | string[]; video_url?: string; url?: string }
  error?: { message?: string; code?: string } | string
  fail_reason?: string
}

export function tryallapiBaseUrl(env: Env) {
  const configured = cleanSecret(env.TRYALLAPI_BASE_URL)
  return (configured ?? DEFAULT_BASE).replace(/\/+$/, '')
}

export function createTryAllApiProvider(env: Env): VideoProvider {
  const key = cleanSecret(env.TRYALLAPI_API_KEY)
  const base = tryallapiBaseUrl(env)
  const headers = () => {
    if (!key) throw new VideoProviderError('provider_not_configured', 'TRYALLAPI_API_KEY missing', false)
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  }

  return {
    id: 'tryallapi',
    async submit(input) {
      const cfg = site.video.tryallapi
      const body: Record<string, unknown> = {
        model: cfg.model,
        prompt: cfg.prompt,
        image: input.imageUrl,
        images: [input.imageUrl],
        duration: input.durationSeconds,
        seconds: String(input.durationSeconds),
        size: cfg.size,
        resolution: cfg.resolution,
        metadata: {
          source_video_url: input.sourceVideoUrl,
          generation_id: input.generationId,
          site: site.domain,
          ...cfg.extra,
        },
      }
      // 部分模型用 input_reference / video 字段接参考视频；按配置透传
      if (cfg.passSourceVideo) {
        body.video = input.sourceVideoUrl
        body.input_reference = input.sourceVideoUrl
      }
      if (input.webhookUrl.startsWith('https://')) {
        body.webhook_url = input.webhookUrl
        body.notify_url = input.webhookUrl
      }

      const response = await fetch(`${base}/v1/video/generations`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      })
      const task = (await response.json().catch(() => null)) as TryAllTask | null
      const requestId = task?.task_id ?? task?.id
      if (!response.ok || !requestId) {
        throw new VideoProviderError(
          `tryallapi_submit_${response.status}`,
          `tryallapi submit failed: ${describeError(task).slice(0, 300)}`,
          isRetryableStatus(response.status),
        )
      }
      return { requestId, meta: { base } }
    },

    async status(requestId, meta): Promise<VideoStatus> {
      const root = String(meta.base ?? base).replace(/\/+$/, '')
      const task = await fetchTask(root, requestId, headers())
      const state = normalizeStatus(task.status)
      if (state === 'pending') return { state: 'pending' }
      if (state === 'failed') {
        return { state: 'failed', code: 'tryallapi_failed', message: describeError(task).slice(0, 500) }
      }
      const url = extractVideoUrl(task)
      if (!url) return { state: 'failed', code: 'tryallapi_no_video', message: 'tryallapi result has no video url' }
      return { state: 'completed', output: { url } }
    },

    costCents: tryallapiCostCents,
  }
}

export function tryallapiCostCents(durationSeconds: number) {
  return Math.round(durationSeconds * site.video.tryallapi.costCentsPerSecond)
}

async function fetchTask(base: string, requestId: string, headers: Record<string, string>) {
  const id = encodeURIComponent(requestId)
  const paths = [`/v1/video/generations/${id}`, `/v1/video/tasks/${id}`]
  let lastError: VideoProviderError | null = null
  for (const path of paths) {
    const response = await fetch(`${base}${path}`, { headers })
    const body = (await response.json().catch(() => null)) as TryAllTask | null
    if (response.status === 404) {
      lastError = new VideoProviderError('tryallapi_not_found', `tryallapi task not found at ${path}`, false)
      continue
    }
    if (!response.ok || !body) {
      throw new VideoProviderError(
        `tryallapi_status_${response.status}`,
        `tryallapi status failed: ${describeError(body).slice(0, 300)}`,
        isRetryableStatus(response.status),
      )
    }
    return body
  }
  throw lastError ?? new VideoProviderError('tryallapi_not_found', 'tryallapi task not found', false)
}

function normalizeStatus(status: string | undefined): 'pending' | 'completed' | 'failed' {
  const value = (status ?? '').toLowerCase()
  if (!value || value === 'queued' || value === 'pending' || value === 'in_progress' || value === 'processing' || value === 'running' || value === 'submitted') {
    return 'pending'
  }
  if (value === 'completed' || value === 'succeeded' || value === 'success' || value === 'finished') return 'completed'
  if (value === 'failed' || value === 'error' || value === 'cancelled' || value === 'canceled') return 'failed'
  return 'pending'
}

function extractVideoUrl(task: TryAllTask): string | null {
  if (typeof task.video_url === 'string' && task.video_url) return task.video_url
  if (typeof task.url === 'string' && /\.(mp4|webm|mov)(\?|$)/i.test(task.url)) return task.url
  if (task.output && typeof task.output === 'object') {
    if (typeof task.output.url === 'string' && task.output.url) return task.output.url
    if (typeof task.output.video_url === 'string' && task.output.video_url) return task.output.video_url
  }
  if (typeof task.output === 'string' && task.output.startsWith('http')) return task.output
  const data = task.data
  if (data) {
    if (typeof data.video_url === 'string' && data.video_url) return data.video_url
    if (typeof data.url === 'string' && data.url) return data.url
    if (typeof data.output === 'string' && data.output.startsWith('http')) return data.output
    if (Array.isArray(data.output)) {
      const first = data.output.find((item) => typeof item === 'string' && item.startsWith('http'))
      if (typeof first === 'string') return first
    }
  }
  return null
}

function describeError(task: TryAllTask | null) {
  if (!task) return 'empty response'
  if (typeof task.error === 'string') return task.error
  if (task.error && typeof task.error === 'object' && typeof task.error.message === 'string') return task.error.message
  if (typeof task.fail_reason === 'string' && task.fail_reason) return task.fail_reason
  return JSON.stringify(task).slice(0, 300)
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 429 || status >= 500
}
