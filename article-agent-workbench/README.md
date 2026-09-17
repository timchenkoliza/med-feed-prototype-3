# Medical Article Agent Workbench

Независимое рабочее пространство для продуктовой проверки медицинских материалов Ленты.

**Сценарий:** вставить публичную ссылку на статью → запустить multi-agent pipeline → получить раздельные слои `source / facts / translation / product / classification / QA` → экспортировать результат в JSON или строкой для рабочей таблицы.

## Что реализовано

Пайплайн работает как оркестратор из шести ролей:

1. **Source Reader** — безопасно забирает публичную страницу, извлекает metadata и readable text. Это детерминированный этап без LLM.
2. **Evidence Extractor** — строит fact layer: material/study type, population, sample size, intervention, comparator, endpoint, outcomes, adverse events, limitations, regulatory status, atomic claims и короткие evidence quotes.
3. **Medical Translator** — переводит только original title + description/deck в контрольный RU baseline. Не редактирует под продукт.
4. **Product Medical Editor** — пишет `ру-заголовок`, `Кратко`, `Для практики` только по frozen fact layer.
5. **Clinical Classifier** — назначает specialty, clinical topics, interventions, 2–5 tags, evidence class. Не выводит GRADE из одного дизайна исследования.
6. **Senior Medical QA** — независимый adversarial judge: перепроверяет output по source + facts, ищет critical errors и выдаёт `PASS / REVIEW / FAIL`.

LLM-этапы идут волнами:

```text
URL
 ↓
Source Reader
 ↓
┌──────────────────────┬──────────────────────┐
│ Evidence Extractor   │ Medical Translator   │
└──────────┬───────────┴──────────┬───────────┘
           ↓                      ↓
        frozen fact layer + translation baseline
           ↓
┌──────────────────────┬──────────────────────┐
│ Product Editor       │ Clinical Classifier  │
└──────────┬───────────┴──────────┬───────────┘
           ↓
      Senior Medical QA
           ↓
      PASS / REVIEW / FAIL
```

## Продуктовые правила, уже зашитые в pipeline

### Перевод

- семантическая эквивалентность важнее кальки;
- нельзя добавлять, удалять, усиливать или ослаблять медицински значимый смысл;
- `may/could/suggest/associated with` не превращаются в доказанную причинность;
- числа, дозы, единицы, сроки, направления эффекта, population, comparator и endpoint сохраняются без произвольного округления;
- торговые названия не выдумываются и не транслитерируются автоматически;
- отсутствие description остаётся отсутствием, а не заполняется моделью.

### «Кратко»

2–3 предложения: что произошло/что исследовали → на ком → главный результат. Только по fact layer, без фонового пересказа и внешнего знания.

### «Для практики»

0–3 пункта четырёх типов:

- `applicability`
- `practice_change`
- `limitation`
- `monitoring_consideration`

Каждый пункт обязан ссылаться на `fact IDs`. Если источник не поддерживает клиническое действие — блок лучше оставить пустым, чем превратить результат исследования в рекомендацию.

### Critical errors

Hard fail вызывают, в частности:

- wrong drug / population / comparator;
- wrong direction of effect;
- wrong number, dose, unit, timeframe, endpoint;
- ошибка safety / contraindication;
- association → causation;
- unsupported recommendation;
- fabricated fact;
- material misclassification.

## Локальный запуск

Требуется Node.js 20+.

```bash
cd article-agent-workbench
cp .env.example .env.local
# заполнить OPENAI_API_KEY
npm install
npm run dev
```

После запуска открыть URL, который покажет `vercel dev`.

### Environment

```bash
OPENAI_API_KEY=...
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL_FAST=gpt-5.6-luna
LLM_MODEL_JUDGE=gpt-5.6-sol
ARTICLE_MAX_CHARS=60000
```

`LLM_BASE_URL` и `LLM_API_KEY` позволяют позже заменить прямой OpenAI API на совместимый корпоративный gateway без переписывания оркестратора.

## Deploy на Vercel

Создать Vercel project из этого GitHub repo и выставить **Root Directory**:

```text
article-agent-workbench
```

Добавить `OPENAI_API_KEY` в Environment Variables. Секрет не попадает во frontend: все model calls выполняются только из `/api/analyze`.

## UI

Workspace показывает:

- timeline шести агентов и фактическую duration/model после прогона;
- source metadata и статус локального whitelist;
- literal translation baseline + translation checks;
- fact card и atomic claims с evidence quotes;
- продуктовый preview `заголовок / Кратко / Для практики`;
- specialty/topic/intervention/tags/evidence class;
- независимые QA scores;
- critical errors и required fixes;
- локальную историю последних 12 прогонов;
- export JSON и TSV-строку для таблицы продукта.

История хранится только в `localStorage` браузера. Backend не сохраняет статьи или результаты.

## Source security

Fetcher намеренно ограничен:

- только `http/https`;
- запрещены `localhost`, `.local`, private/link-local IP;
- DNS проверяется до запроса;
- каждый redirect заново валидируется;
- max 5 redirects;
- max 2 MB source body;
- timeout 12 секунд;
- исполняемый JavaScript страницы не запускается.

Это снижает риск SSRF, но workspace всё равно рассчитан только на публичные материалы. Не использовать для EMR, ПДн пациента, интранет-ссылок и закрытых документов.

## Ограничения v0.1

- длинные статьи обрезаются до `ARTICLE_MAX_CHARS`; такой прогон не может автоматически получить PASS;
- нет полноценного chunk/reduce для full-text исследований;
- source whitelist пока только seed registry (FDA/EMA); его нужно заменить на продуктовый реестр;
- нет persistence на backend и командной базы gold examples;
- пока исполняется один production pipeline `facts → RU product output`; 4-way SBS (`facts→summary`, `translate→summary`, `summary→translate`, direct cross-lingual) будет следующим режимом;
- QA agent является вспомогательным gate и не заменяет врачебную экспертную приемку gold set.

## Следующая CTO-итерация

1. вынести prompts/rules в версионируемый registry, чтобы менять их без правки orchestration code;
2. добавить review mode: человек редактирует output и нажимает `Accept as gold`;
3. сохранять gold objects и diffs в Git/DB;
4. добавить 4-way SBS runner и blind expert review;
5. сделать chunked evidence extraction для длинных статей;
6. подключить реальный whitelist источников;
7. добавить regression suite: новый prompt/model не проходит deploy, если ломает утверждённые gold fixtures.
