import { randomUUID } from 'node:crypto'
import { extractArticle, capArticleForModel } from '../lib/article.mjs'
import { models, runJsonAgent } from '../lib/llm.mjs'
import {
  FACT_EXTRACTOR_PROMPT,
  TRANSLATOR_PROMPT,
  PRODUCT_EDITOR_PROMPT,
  CLASSIFIER_PROMPT,
  QA_PROMPT,
  articleEnvelope,
} from '../lib/prompts.mjs'

function send(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function sourceMetadata(article) {
  return {
    requestedUrl: article.requestedUrl,
    finalUrl: article.finalUrl,
    domain: article.domain,
    language: article.language,
    titleOriginal: article.title,
    descriptionOriginal: article.description,
    authors: article.authors,
    publicationDate: article.publicationDate,
    truncated: article.truncated,
    originalChars: article.originalChars,
    analyzedChars: article.text.length,
    extractionWarnings: article.extractionWarnings,
  }
}

function deterministicSourceTrust(domain) {
  // This is deliberately NOT a medical-quality score. It only reflects a tiny seed registry.
  const trustedRegulators = new Set(['fda.gov', 'www.fda.gov', 'ema.europa.eu', 'www.ema.europa.eu'])
  if (trustedRegulators.has(domain)) {
    return { whitelistStatus: 'seed_whitelist', category: 'regulator', note: 'Domain matched the local seed registry; replace with the product whitelist.' }
  }
  return { whitelistStatus: 'not_evaluated', category: null, note: 'Product source whitelist is not configured for this domain.' }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })

  const startedAt = Date.now()
  const trace = []
  const runId = randomUUID()

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const url = String(body.url || '').trim()
    if (!url) return send(res, 400, { error: 'Передайте URL статьи' })

    const sourceStarted = Date.now()
    const extracted = await extractArticle(url)
    const article = capArticleForModel(extracted)
    trace.push({ agent: 'Source Reader', model: 'deterministic', status: 'done', durationMs: Date.now() - sourceStarted })

    const modelCfg = models()
    const sourceInput = articleEnvelope(article)

    // Wave 1: evidence extraction and literal translation are independent.
    const [factsRun, translationRun] = await Promise.all([
      runJsonAgent({
        agent: 'Evidence Extractor',
        instructions: FACT_EXTRACTOR_PROMPT,
        input: sourceInput,
        model: modelCfg.fast,
        effort: 'medium',
        maxOutputTokens: 6500,
      }),
      runJsonAgent({
        agent: 'Medical Translator',
        instructions: TRANSLATOR_PROMPT,
        input: JSON.stringify({
          title: article.title,
          description: article.description,
          source_language: article.language,
        }),
        model: modelCfg.fast,
        effort: 'low',
        maxOutputTokens: 1800,
      }),
    ])
    trace.push(factsRun.trace, translationRun.trace)

    const facts = factsRun.data
    const translation = translationRun.data

    // Wave 2: product writing and classification depend on the frozen fact layer.
    const factBoundInput = JSON.stringify({
      source: sourceMetadata(article),
      facts,
    })

    const [editorRun, classifierRun] = await Promise.all([
      runJsonAgent({
        agent: 'Product Medical Editor',
        instructions: PRODUCT_EDITOR_PROMPT,
        input: factBoundInput,
        model: modelCfg.fast,
        effort: 'medium',
        maxOutputTokens: 3500,
      }),
      runJsonAgent({
        agent: 'Clinical Classifier',
        instructions: CLASSIFIER_PROMPT,
        input: factBoundInput,
        model: modelCfg.fast,
        effort: 'low',
        maxOutputTokens: 2600,
      }),
    ])
    trace.push(editorRun.trace, classifierRun.trace)

    const product = editorRun.data
    const classification = classifierRun.data

    // Wave 3: independent senior auditor sees both source and generated artifacts.
    const qaRun = await runJsonAgent({
      agent: 'Senior Medical QA',
      instructions: QA_PROMPT,
      input: JSON.stringify({
        source: sourceMetadata(article),
        source_text: article.text,
        facts,
        translation,
        product,
        classification,
      }),
      model: modelCfg.judge,
      effort: 'high',
      maxOutputTokens: 6000,
    })
    trace.push(qaRun.trace)

    const qa = qaRun.data
    if (article.truncated && qa.decision === 'PASS') {
      qa.decision = 'REVIEW'
      qa.qa_notes = [...(qa.qa_notes || []), 'Decision downgraded to REVIEW because the source text was truncated before model analysis.']
    }

    return send(res, 200, {
      runId,
      pipelineVersion: '0.1.0',
      pipeline: 'source → facts || translation → product || classification → independent QA',
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      source: {
        ...sourceMetadata(article),
        trust: deterministicSourceTrust(article.domain),
      },
      facts,
      translation,
      product,
      classification,
      qa,
      trace,
    })
  } catch (error) {
    if (error?.trace) trace.push(error.trace)
    return send(res, 500, {
      error: error?.message || String(error),
      runId,
      trace,
      durationMs: Date.now() - startedAt,
    })
  }
}
