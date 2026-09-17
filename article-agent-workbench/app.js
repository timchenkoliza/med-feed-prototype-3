const $ = (selector) => document.querySelector(selector)
const $$ = (selector) => [...document.querySelectorAll(selector)]
const HISTORY_KEY = 'med-article-agent-workbench-runs-v1'
let currentRun = null

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function fmt(value) {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function setRunStatus(text, cls = 'neutral') {
  const el = $('#run-status')
  el.textContent = text
  el.className = `status ${cls}`
}

function setAgent(agent, state, detail) {
  const el = $(`.agent[data-agent="${agent}"]`)
  if (!el) return
  el.classList.remove('running', 'done', 'failed')
  if (state !== 'waiting') el.classList.add(state)
  const b = el.querySelector('b')
  b.textContent = detail || state
}

function resetAgents() {
  $$('.agent').forEach(el => {
    el.classList.remove('running', 'done', 'failed')
    el.querySelector('b').textContent = 'waiting'
  })
}

function markAllRunning() {
  $$('.agent').forEach(el => {
    el.classList.add('running')
    el.querySelector('b').textContent = 'running'
  })
}

function applyTrace(trace = []) {
  for (const item of trace) {
    const duration = item.durationMs ? `${(item.durationMs / 1000).toFixed(1)}s` : item.status
    setAgent(item.agent, item.status === 'done' ? 'done' : 'failed', duration)
  }
}

function renderDl(el, rows) {
  el.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(fmt(v))}</dd>`).join('')
}

function renderChecks(el, checks = {}) {
  el.innerHTML = Object.entries(checks).map(([k, v]) => `<span class="check ${v === true ? 'ok' : v === false ? 'bad' : ''}">${esc(k)}: ${esc(v)}</span>`).join('')
}

function renderFacts(run) {
  const f = run.facts || {}
  const fields = [
    ['Тип материала', f.material_type],
    ['Тип исследования', f.study_type],
    ['Популяция', f.population],
    ['Размер выборки', f.sample_size],
    ['Вмешательство', f.intervention],
    ['Comparator', f.comparator],
    ['Primary endpoint', f.primary_endpoint],
    ['Regulatory status', f.regulatory_status],
  ]
  $('#fact-summary').innerHTML = fields.map(([k, v]) => `<div class="fact"><span>${esc(k)}</span><strong>${esc(fmt(v))}</strong></div>`).join('')
  const claims = f.key_claims || []
  $('#claims').innerHTML = claims.length
    ? claims.map(c => `<div class="claim"><strong>${esc(c.id)} · ${esc(c.claim)}</strong><q>${esc(c.evidence_quote || 'нет evidence quote')}</q></div>`).join('')
    : '<div class="ok-empty">Атомарные claims не извлечены.</div>'
}

function renderProduct(run) {
  const p = run.product || {}
  $('#product-title').textContent = p.title_ru || '—'
  $('#brief').innerHTML = (p.brief || []).map(x => `<p>${esc(x)}</p>`).join('') || '<p>—</p>'
  $('#practice').innerHTML = (p.for_practice || []).length
    ? p.for_practice.map(x => `<div class="practice-item"><small>${esc(x.type)} · ${esc((x.supported_by_fact_ids || []).join(', '))}</small>${esc(x.text)}</div>`).join('')
    : '<div class="ok-empty">Источник не поддерживает отдельное действие для врача — блок оставлен пустым.</div>'

  const tags = run.classification?.tags || []
  $('#product-tags').innerHTML = tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')
}

function renderQa(run) {
  const qa = run.qa || {}
  const scores = qa.scores || {}
  $('#qa-scores').innerHTML = Object.entries(scores).map(([k, v]) => `<div class="score"><strong>${esc(v)}/5</strong><span>${esc(k)}</span></div>`).join('')
  const errors = qa.critical_errors || []
  $('#critical-errors').innerHTML = errors.length
    ? errors.map(e => `<div class="error-item"><strong>${esc(e.type)}</strong> · ${esc(e.location)}<br>${esc(e.text)}</div>`).join('')
    : '<div class="ok-empty">Critical errors не обнаружены.</div>'
  $('#required-fixes').innerHTML = (qa.required_fixes || []).map(x => `<li>${esc(x)}</li>`).join('') || '<li>Нет обязательных правок.</li>'
}

function renderTrace(trace = []) {
  $('#trace-table').innerHTML = trace.map(t => {
    const usage = t.usage ? `${t.usage.input_tokens ?? '?'} in / ${t.usage.output_tokens ?? '?'} out` : '—'
    return `<div class="trace-row"><strong>${esc(t.agent)}</strong><span>${esc(t.model)}</span><span>${esc((t.durationMs / 1000).toFixed(1))}s</span><span>${esc(usage)}</span></div>`
  }).join('')
}

function renderResult(run) {
  currentRun = run
  $('#error-panel').classList.add('hidden')
  $('#result').classList.remove('hidden')
  applyTrace(run.trace)

  const decision = run.qa?.decision || 'REVIEW'
  $('#decision').textContent = decision
  $('#run-duration').textContent = `${(run.durationMs / 1000).toFixed(1)} сек · ${run.runId.slice(0, 8)}`
  $('#decision-note').textContent = decision === 'PASS'
    ? 'Hard gates пройдены; материал остаётся кандидатом на продуктовую/экспертную приемку.'
    : decision === 'FAIL'
      ? 'Обнаружена критическая ошибка: такой output нельзя публиковать без исправления.'
      : 'Нужна ручная проверка: pipeline не имеет достаточных оснований для автоматического PASS.'
  setRunStatus(decision, decision.toLowerCase())

  renderDl($('#source-dl'), [
    ['Автор(ы)', run.source.authors],
    ['Дата', run.source.publicationDate],
    ['Источник', run.source.domain],
    ['Оригинальный заголовок', run.source.titleOriginal],
    ['Оригинальное описание', run.source.descriptionOriginal],
    ['URL', run.source.finalUrl],
    ['Язык', run.source.language],
    ['Whitelist', run.source.trust?.whitelistStatus],
    ['Текст', `${run.source.analyzedChars}/${run.source.originalChars} chars${run.source.truncated ? ' · TRUNCATED' : ''}`],
  ])

  $('#translation-title').textContent = run.translation?.title_ru || '—'
  $('#translation-description').textContent = run.translation?.description_ru || '—'
  renderChecks($('#translation-checks'), run.translation?.checks || {})
  renderFacts(run)
  renderProduct(run)

  renderDl($('#classification-dl'), [
    ['Специальности', run.classification?.specialties],
    ['Клиническая тема', run.classification?.clinical_topics],
    ['Технологии / вмешательства', run.classification?.technologies_interventions],
    ['Класс evidence', run.classification?.evidence_class],
    ['Уровень доказательности', run.classification?.evidence_level],
    ['Значение уровня', run.classification?.evidence_level_value],
    ['Категория источника', run.classification?.source_category],
    ['Теги', run.classification?.tags],
  ])

  renderQa(run)
  renderTrace(run.trace)
  saveHistory(run)
}

function compactHistory(run) {
  return {
    runId: run.runId,
    createdAt: run.createdAt,
    durationMs: run.durationMs,
    source: run.source,
    facts: run.facts,
    translation: run.translation,
    product: run.product,
    classification: run.classification,
    qa: run.qa,
    trace: run.trace,
    pipelineVersion: run.pipelineVersion,
  }
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') } catch { return [] }
}

function saveHistory(run) {
  const history = loadHistory().filter(x => x.runId !== run.runId)
  history.unshift(compactHistory(run))
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 12)))
  renderHistory()
}

function renderHistory() {
  const history = loadHistory()
  $('#history').innerHTML = history.length
    ? history.map((x, i) => `<div class="history-item"><div><button type="button" data-history="${i}">${esc(x.source?.titleOriginal || x.source?.finalUrl || x.runId)}</button><br><small>${esc(new Date(x.createdAt).toLocaleString('ru-RU'))} · ${esc(x.qa?.decision || 'REVIEW')}</small></div><small>${esc(x.source?.domain || '')}</small></div>`).join('')
    : '<p class="hint">Пока нет локальных прогонов.</p>'
  $$('[data-history]').forEach(btn => btn.addEventListener('click', () => renderResult(history[Number(btn.dataset.history)])))
}

function asTsv(run) {
  const row = [
    (run.source.authors || []).join('; '),
    run.source.publicationDate,
    run.source.domain,
    run.source.titleOriginal,
    run.source.finalUrl,
    (run.product?.brief || []).join(' '),
    (run.product?.for_practice || []).map(x => x.text).join(' • '),
    run.facts?.study_type,
    run.facts?.sample_size,
    run.classification?.evidence_level_value || run.classification?.evidence_level,
    (run.classification?.specialties || []).join('; '),
    (run.classification?.clinical_topics || []).join('; '),
    (run.classification?.technologies_interventions || []).join('; '),
    '',
    (run.classification?.tags || []).join('; '),
  ]
  return row.map(v => String(v ?? '').replace(/[\t\n\r]+/g, ' ')).join('\t')
}

async function copy(text) {
  await navigator.clipboard.writeText(text)
}

$('#analyze-form').addEventListener('submit', async event => {
  event.preventDefault()
  const button = $('#run-button')
  const url = $('#url').value.trim()
  $('#result').classList.add('hidden')
  $('#error-panel').classList.add('hidden')
  resetAgents()
  markAllRunning()
  setRunStatus('Агенты работают…', 'running')
  button.disabled = true
  button.textContent = 'Анализируем…'

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    const payload = await response.json()
    if (!response.ok) {
      applyTrace(payload.trace || [])
      throw new Error(payload.error || `HTTP ${response.status}`)
    }
    renderResult(payload)
  } catch (error) {
    setRunStatus('Ошибка', 'fail')
    $('#error-panel').textContent = error.message || String(error)
    $('#error-panel').classList.remove('hidden')
  } finally {
    button.disabled = false
    button.textContent = 'Прогнать статью'
  }
})

$('#copy-json').addEventListener('click', () => currentRun && copy(JSON.stringify(currentRun, null, 2)))
$('#copy-tsv').addEventListener('click', () => currentRun && copy(asTsv(currentRun)))
$('#download-json').addEventListener('click', () => {
  if (!currentRun) return
  const blob = new Blob([JSON.stringify(currentRun, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `article-analysis-${currentRun.runId.slice(0, 8)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
})
$('#clear-history').addEventListener('click', () => {
  localStorage.removeItem(HISTORY_KEY)
  renderHistory()
})

renderHistory()
