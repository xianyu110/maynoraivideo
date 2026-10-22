// scripts/seo-check.mjs 的类型声明，供 tests/e2e/seo.spec.ts 引用
export interface SeoFinding {
  level: 'error' | 'warn' | 'info'
  where: string
  check: string
  detail: string
}

export interface SeoPage {
  path: string
  kind: 'home' | 'article' | 'page'
  title: string
  titleWidth: number
  descriptionWidth: number
  h1: string[]
  h2: string[]
  canonical: string | null
  hreflang: string[]
  jsonLd: string[]
  faqQuestions?: number
}

export interface SeoCheckResult {
  base: string
  production: boolean
  checkedAt: string
  pages: SeoPage[]
  findings: SeoFinding[]
  errors: number
  warnings: number
}

export function runSeoCheck(options?: { base?: string; production?: boolean }): Promise<SeoCheckResult>
