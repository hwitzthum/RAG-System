# Phase 11 Benchmark Report

Generated: 2026-08-05T14:13:12.489Z
Mode: dry-run
Dataset: /Users/hwitzthum/rag-system/evaluation/evaluation_queries.generated.json
Corpus fingerprint: `7125c1245ec8d65dcf5f09f6904ff23fdd433f3e0dee6022eabc67bf9b629e98`
Run artifact: /Users/hwitzthum/rag-system/evaluation/runs/benchmark-2026-08-05T14-13-12-489Z.json
Evaluated queries: 63
Generator model: n/a
Judge model: n/a

## Run Configuration

| Setting | Value |
| --- | --- |
| n/a | dry-run: no live configuration loaded |

## Summary

| Metric | Value |
| --- | ---: |
| Query count | 63 |
| Evaluated queries | 63 |
| System error count | 0 |
| Answerable / unanswerable | 48 / 15 |
| False answer rate (unanswerable slice) | 0 |
| False abstention rate (answerable slice) | 0 |
| Recall@5 | 1 |
| nDCG@10 | 1 |
| MRR | 1 |
| Citation evidence hit rate | 1 |
| Verified citation rate | 1 (48 verified) |
| Citation accuracy (strict, report-only) | 1 |
| Answer truncation rate | 0 |
| Cache hit rate | 1 |
| Uncached p50 latency (ms) | 1413 |
| Uncached p95 latency (ms) | 1859 |
| Cached p50 latency (ms) | 418 |
| Cached p95 latency (ms) | 612 |

## Token-Overlap Grounding (report-only, NOT gated)

Bag-of-words overlap against the chunks that produced the answer. Kept for
continuity only: it measures whether the model quoted its own evidence, which
the system prompt instructs it to do, so it cannot detect an unsupported claim.
Abstentions are excluded rather than scored as perfectly grounded.

| Metric | Value |
| --- | ---: |
| Scored queries (abstentions excluded) | 48 |
| Grounding score | 1 |
| Hallucination rate | 0 |

## LLM-Judge Metrics (faithfulness is gated; the rest are report-only)

Judge noise floor: ±0.01 (measured across two runs over
byte-identical retrieved chunks). Any judge-metric delta below this is
indistinguishable from run-to-run variance — do not read it as signal.
Limitations sections are stripped from answers before statement extraction:
their negative-existential claims ("the evidence does not establish X") can
never be "supported by the evidence" and previously biased faithfulness
downward for every answer.

| Metric | Value |
| --- | ---: |
| Judged queries | 0 |
| Faithfulness (GATED) | n/a |
| Answer relevance | n/a |
| Context precision | n/a |
| Context recall | n/a |
| Abstention rate | n/a |

## Threshold Gates

| Metric | Target | Actual | Status |
| --- | --- | ---: | --- |
| Recall@5 | >= 0.85 | 1 | PASS |
| nDCG@10 | >= 0.8 | 1 | PASS |
| Citation evidence hit rate | >= 0.8 | 1 | PASS |
| Verified citation rate | >= 0.9 | 1 | PASS |
| Faithfulness (LLM judge) | >= 0.9 | 0 | FAIL |
| False answer rate (unanswerable slice) | <= 0.1 | 0 | PASS |
| False abstention rate (answerable slice) | <= 0.05 | 0 | PASS |
| Cache hit rate | >= 0.3 | 1 | PASS |
| Uncached p50 latency (ms) | < 8000 | 1413 | PASS |
| Uncached p95 latency (ms) | < 15000 | 1859 | PASS |
| Cached p50 latency (ms) | < 7000 | 418 | PASS |
| Cached p95 latency (ms) | < 12000 | 612 | PASS |
| Recall@5 [EN] | >= 0.85 | 1 | PASS |
| nDCG@10 [EN] | >= 0.8 | 1 | PASS |
| Recall@5 [DE] | >= 0.85 | 1 | PASS |
| nDCG@10 [DE] | >= 0.8 | 1 | PASS |

## Per-Language Breakdown

| Language | Queries | Recall@5 | nDCG@10 | Citation acc. | Faithfulness | Cache hit | Uncached p95 (ms) | Cached p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| EN | 26 | 1 | 1 | 1 | n/a | 1 | 1840 | 617 |
| DE | 37 | 1 | 1 | 1 | n/a | 1 | 1872 | 612 |
| FR | 0 | 0 | 0 | 0 | n/a | 0 | 0 | 0 |
| IT | 0 | 0 | 0 | 0 | n/a | 0 | 0 | 0 |
| ES | 0 | 0 | 0 | 0 | n/a | 0 | 0 | 0 |

## Open Risks

- Faithfulness (LLM judge) gate failed (actual 0, target >= 0.9).

## Failure Sample

| Query ID | Language | Failure types |
| --- | --- | --- |
| none | n/a | n/a |

## Release Recommendation

Release blocked until failed gates are remediated and benchmark is re-run.
