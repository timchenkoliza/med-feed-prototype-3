import * as cheerio from 'cheerio'
import { lookup } from 'node:dns/promises'

const MAX_BYTES = 2_000_000
const FETCH_TIMEOUT_MS = 12_000
const MAX_REDIRECTS = 5

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false
  const [a, b] = parts
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

function isPrivateIpv6(ip) {
  const v = ip.toLowerCase()
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')
}

function isPrivateAddress(address) {
  return address.includes(':') ? isPrivateIpv6(address) : isPrivateIpv4(address)
}

export async function assertPublicHttpUrl(rawUrl) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Некорректный URL')
  }

  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Разрешены только http/https URL')
  if (!url.hostname || url.username || url.password) throw new Error('URL с credentials не поддерживается')
  if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) throw new Error('Локальные адреса запрещены')

  const directHost = url.hostname.replace(/^\[|\]$/g, '')
  if (isPrivateAddress(directHost)) throw new Error('Приватные сетевые адреса запрещены')

  try {
    const resolved = await lookup(url.hostname, { all: true, verbatim: true })
    if (resolved.some(({ address }) => isPrivateAddress(address))) {
      throw new Error('URL резолвится в приватный сетевой адрес')
    }
  } catch (error) {
    if (String(error?.message || error).includes('приватный')) throw error
    throw new Error(`Не удалось разрешить домен: ${url.hostname}`)
  }

  return url
}

async function fetchStep(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      redirect: 'manual',
      headers: {
        'User-Agent': 'Yandex-Med-Article-Workbench/0.1 (+medical-content-evaluation)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

async function safeFetch(rawUrl) {
  let current = rawUrl
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    await assertPublicHttpUrl(current)
    const response = await fetchStep(current)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`Redirect ${response.status} без Location`)
      current = new URL(location, current).toString()
      continue
    }
    if (!response.ok) throw new Error(`Источник вернул HTTP ${response.status}`)
    return { response, finalUrl: current }
  }
  throw new Error(`Слишком много redirect (> ${MAX_REDIRECTS})`)
}

function pickMeta($, selectors) {
  for (const selector of selectors) {
    const el = $(selector).first()
    const value = el.attr('content') || el.attr('datetime') || el.text()
    if (value?.trim()) return value.trim()
  }
  return null
}

function parseJsonLd($) {
  const out = []
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim()
    if (!raw) return
    try {
      const parsed = JSON.parse(raw)
      const items = Array.isArray(parsed) ? parsed : parsed['@graph'] ? parsed['@graph'] : [parsed]
      for (const item of items) if (item && typeof item === 'object') out.push(item)
    } catch {
      // Ignore malformed publisher JSON-LD. Metadata selectors remain available.
    }
  })
  return out
}

function normalizeAuthors(value) {
  if (!value) return []
  const values = Array.isArray(value) ? value : [value]
  return values
    .flatMap(v => {
      if (typeof v === 'string') return [v]
      if (v && typeof v === 'object') return [v.name || [v.givenName, v.familyName].filter(Boolean).join(' ')]
      return []
    })
    .map(v => String(v || '').trim())
    .filter(Boolean)
}

function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractReadableText($) {
  $('script,style,noscript,svg,form,nav,footer,header,aside,iframe').remove()
  const root = $('article').first().length ? $('article').first() : $('main').first().length ? $('main').first() : $('body').first()
  const chunks = []
  root.find('h1,h2,h3,p,li,blockquote,table').each((_, el) => {
    const text = cleanText($(el).text())
    if (text.length >= 20) chunks.push(text)
  })
  const deduped = chunks.filter((text, idx) => idx === 0 || text !== chunks[idx - 1])
  return cleanText(deduped.join('\n\n'))
}

export async function extractArticle(rawUrl) {
  const { response, finalUrl } = await safeFetch(rawUrl)
  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml') && !contentType.includes('text/plain')) {
    throw new Error(`Неподдерживаемый Content-Type: ${contentType || 'unknown'}`)
  }

  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (declaredLength > MAX_BYTES) throw new Error(`Материал слишком большой (> ${MAX_BYTES} bytes)`)

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_BYTES) throw new Error(`Материал слишком большой (> ${MAX_BYTES} bytes)`)
  const html = new TextDecoder('utf-8').decode(bytes)

  if (contentType.includes('text/plain')) {
    return {
      requestedUrl: rawUrl,
      finalUrl,
      domain: new URL(finalUrl).hostname,
      language: null,
      title: null,
      description: null,
      authors: [],
      publicationDate: null,
      text: cleanText(html),
      extractionWarnings: ['text/plain: структурные metadata не извлечены'],
    }
  }

  const $ = cheerio.load(html)
  const jsonLd = parseJsonLd($)
  const articleLd = jsonLd.find(item => {
    const type = Array.isArray(item['@type']) ? item['@type'] : [item['@type']]
    return type.some(v => ['Article', 'NewsArticle', 'MedicalScholarlyArticle', 'ScholarlyArticle', 'Report'].includes(v))
  }) || {}

  const title = pickMeta($, [
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
    'h1',
    'title',
  ]) || articleLd.headline || articleLd.name || null

  const description = pickMeta($, [
    'meta[name="description"]',
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
  ]) || articleLd.description || null

  const authorMeta = pickMeta($, ['meta[name="author"]', '[rel="author"]'])
  const authors = [...new Set([
    ...normalizeAuthors(articleLd.author),
    ...normalizeAuthors(authorMeta),
  ])]

  const publicationDate = pickMeta($, [
    'meta[property="article:published_time"]',
    'meta[name="date"]',
    'meta[name="citation_publication_date"]',
    'time[datetime]',
  ]) || articleLd.datePublished || null

  const language = $('html').attr('lang')?.trim() || articleLd.inLanguage || null
  const text = extractReadableText($)
  if (text.length < 200) throw new Error('Не удалось извлечь содержательный текст статьи')

  return {
    requestedUrl: rawUrl,
    finalUrl,
    domain: new URL(finalUrl).hostname,
    language,
    title: cleanText(title),
    description: cleanText(description),
    authors,
    publicationDate: publicationDate ? String(publicationDate).trim() : null,
    text,
    extractionWarnings: [],
  }
}

export function capArticleForModel(article) {
  const configured = Number(process.env.ARTICLE_MAX_CHARS || 60_000)
  const maxChars = Number.isFinite(configured) && configured >= 10_000 ? configured : 60_000
  if (article.text.length <= maxChars) return { ...article, truncated: false, originalChars: article.text.length }
  return {
    ...article,
    text: article.text.slice(0, maxChars),
    truncated: true,
    originalChars: article.text.length,
    extractionWarnings: [...article.extractionWarnings, `Текст обрезан до ${maxChars} символов перед LLM-анализом`],
  }
}
