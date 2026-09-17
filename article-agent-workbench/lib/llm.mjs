const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const REQUEST_TIMEOUT_MS = 45_000

function getConfig() {
  const baseUrl = (process.env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '')
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('LLM API key не настроен: задайте OPENAI_API_KEY или LLM_API_KEY')
  return {
    baseUrl,
    apiKey,
    fastModel: process.env.LLM_MODEL_FAST || 'gpt-5.6-luna',
    judgeModel: process.env.LLM_MODEL_JUDGE || 'gpt-5.6-sol',
  }
}

function responseText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim()
  const chunks = []
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') chunks.push(content.text)
      else if (typeof content?.value === 'string') chunks.push(content.value)
    }
  }
  return chunks.join('\n').trim()
}

function parseJsonLoose(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) throw new Error('LLM вернула пустой ответ')

  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  try {
    return JSON.parse(unfenced)
  } catch {
    const start = unfenced.indexOf('{')
    const end = unfenced.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1))
      } catch {
        // fall through
      }
    }
    throw new Error(`LLM вернула невалидный JSON: ${unfenced.slice(0, 300)}`)
  }
}

async function postResponse({ model, instructions, input, effort, maxOutputTokens }) {
  const { baseUrl, apiKey } = getConfig()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        instructions,
        input,
        reasoning: { effort },
        max_output_tokens: maxOutputTokens,
      }),
    })

    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || `HTTP ${response.status}`
      throw new Error(`LLM API: ${detail}`)
    }
    return { payload, text: responseText(payload) }
  } finally {
    clearTimeout(timer)
  }
}

export function models() {
  const cfg = getConfig()
  return { fast: cfg.fastModel, judge: cfg.judgeModel }
}

export async function runJsonAgent({ agent, instructions, input, model, effort = 'low', maxOutputTokens = 4500 }) {
  const startedAt = Date.now()
  try {
    const { payload, text } = await postResponse({ model, instructions, input, effort, maxOutputTokens })
    const data = parseJsonLoose(text)
    return {
      data,
      trace: {
        agent,
        model,
        status: 'done',
        durationMs: Date.now() - startedAt,
        responseId: payload?.id || null,
        usage: payload?.usage || null,
      },
    }
  } catch (error) {
    const wrapped = new Error(`${agent}: ${error?.message || error}`)
    wrapped.trace = {
      agent,
      model,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: error?.message || String(error),
    }
    throw wrapped
  }
}
