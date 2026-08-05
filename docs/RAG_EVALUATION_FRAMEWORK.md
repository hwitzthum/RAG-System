# RAG_EVALUATION_FRAMEWORK.md

Version: 3.0  
Date: 2026-03-06

## Goal

Measure retrieval quality, answer grounding, cache effectiveness, and production readiness.

## Evaluation Scope

The framework validates:

- retrieval relevance and ranking quality
- citation correctness and answer grounding
- hallucination control
- multilingual consistency
- cache impact on latency and cost

## Dataset Requirements

File: `evaluation/evaluation_queries.generated.json` — generated from the real
corpus by `npm run eval:dataset:corpus`. The file is an envelope
`{corpusFingerprint, generatedAt, generatorModel, records}`; the benchmark
refuses to run when the live corpus no longer matches the fingerprint, so a
re-ingest requires regenerating the dataset.

Minimum dataset size (sized to the real corpus and its languages):

- 25 labeled queries total
- 5 answerable queries per language actually present in the corpus
- an unanswerable slice (~15 questions whose probe terms are verified absent
  from every chunk) — without it, abstention is unmeasurable

Required fields per record:

- `id`
- `language`
- `question`
- `question_type` (`single_hop` | `multi_hop` | `unanswerable` | `adversarial`)
- `expected_chunk_ids` (array — exact ground truth; empty only for unanswerable)
- `expected_document` (empty for unanswerable)
- `expected_section`
- `expected_pages` (array)
- `acceptable_answer_points` (array; empty for unanswerable)

## Core Metrics

### Retrieval Metrics

- Recall@5: expected relevant chunk appears in top 5
- nDCG@10: ranking quality across top 10 results
- MRR: first relevant rank quality

### Answer Quality Metrics

- Citation accuracy: cited sources match expected document/page evidence
- Grounding score: answer statements supported by retrieved passages
- Hallucination rate: unsupported answer statements / total statements

### System Metrics

- Cache hit rate
- p50/p95 uncached latency
- p50/p95 cached latency
- reranker/model error rate

## Benchmark Procedure

For each query:

1. run query with cache bypassed
2. capture retrieval set, reranker scores, answer, citations, latency
3. repeat same query with cache enabled
4. verify cache hit behavior and compare latency
5. store run artifacts for traceability

Run the full suite separately for each supported language and then aggregate.

## Execution Commands

Use the Phase 11 scripts:

```bash
npm run eval:dataset:corpus
npm run eval:dataset:validate
npm run eval:benchmark:dry
npm run eval:benchmark
```

Outputs:

- run artifacts: `evaluation/runs/benchmark-<timestamp>.json`
- release reports: `evaluation/reports/benchmark-<timestamp>.md`
- latest pointers: `evaluation/runs/latest.json`, `evaluation/reports/latest.md`

## Target Thresholds (Release Gates)

- Recall@5: `>= 0.85`
- nDCG@10: `>= 0.80`
- Citation accuracy: `>= 0.90`
- Hallucination rate: `< 0.05`
- Cache hit rate on repeated-query workload: `>= 0.30`
- Uncached p95 latency: `< 7s`
- Cached p95 latency: `< 2.5s`

If any threshold fails, release is blocked.

## Regression Policy

- run full benchmark in staging before each release
- run reduced smoke benchmark on each main-branch merge
- compare against last approved baseline
- investigate any statistically significant degradation

## Failure Analysis Requirements

Each failed benchmark must capture:

- query id and language
- failure type (`retrieval`, `citation`, `grounding`, `latency`, `cache`, `system_error`)
- candidate chunks and scores
- final answer and citations
- probable root cause and remediation ticket

## Reporting

Produce one release report per candidate deployment with:

- metric summary table
- per-language breakdown
- pass/fail status per threshold
- open risk items
- release recommendation

End of file
