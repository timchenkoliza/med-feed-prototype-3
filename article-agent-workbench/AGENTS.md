# Agent contract — Medical Article Workbench

Этот файл определяет роли как независимые контракты. Не объединять их в один «универсальный» prompt: нам важно диагностировать, на каком этапе возникла ошибка.

## 0. Orchestrator

Не создаёт медицинские факты. Управляет порядком вызовов, freezing фактов, trace, fail/review gates и экспортом.

## 1. Source Reader

**Тип:** deterministic code, не LLM.

**Вход:** public HTTP(S) URL.

**Выход:** canonical/final URL, domain, language, original title, original description, authors, publication date, readable text, extraction warnings, truncation status.

**Запрет:** не обходить авторизацию, paywall, robots/access controls; не исполнять JS сайта; не ходить в private networks.

## 2. Evidence Extractor

**Job:** построить frozen factual substrate.

**Обязан:** извлечь material/study type, population, N, intervention, comparator, endpoint, outcomes, adverse events, limitations, regulatory status, atomic `F1...Fn` claims и короткие verbatim evidence quotes.

**Запрет:** внешние знания; достраивание отсутствующих данных; GRADE из study type; causal upgrade.

## 3. Medical Translator

**Job:** literal-but-natural translation benchmark для original title + original description.

**Обязан сохранить:** entities, numbers, units, negation, modality, causality, uncertainty.

**Запрет:** продуктовый rewrite, новые факты, CTA, clinical implication.

## 4. Product Medical Editor

**Job:** сделать врачебную карточку из frozen facts.

**Output:** `card_type`, `title_ru`, 2–3 sentence `brief`, 0–3 `for_practice` bullets.

Каждый `for_practice` bullet обязан содержать `supported_by_fact_ids`.

Если из source нельзя вывести действие — использовать applicability/limitation или пустой блок.

## 5. Clinical Classifier

**Job:** metadata для фильтрации/ранжирования.

**Output:** specialties, clinical_topics, technologies/interventions, 2–5 tags, evidence_class, evidence_level, source_category.

**Важно:** `evidence_level=not_assessed`, если grade не задан самим источником/формальной методикой. Не подменять evidence hierarchy GRADE-оценкой.

## 6. Senior Medical QA

**Job:** adversarial verification. Считать upstream агентов потенциально ошибочными.

Проверяет source ↔ facts ↔ translation ↔ product ↔ classification.

**Hard FAIL:** wrong drug/population/comparator/direction/number/unit/dose/timeframe/endpoint/safety; association→causation; fabricated fact; unsupported recommendation; critical misclassification.

**REVIEW:** существенная неопределённость, incomplete/truncated source, score gate не пройден, но critical error не доказан.

**PASS:** нет critical errors; groundedness, medical correctness и translation fidelity >= 4/5; source не truncated.

## Gold workflow

Model output не становится gold автоматически.

1. run pipeline;
2. human/physician review;
3. исправить facts/translation/product/classification;
4. принять как gold;
5. использовать gold только как regression/evaluation target, а не как новый медицинский источник.
