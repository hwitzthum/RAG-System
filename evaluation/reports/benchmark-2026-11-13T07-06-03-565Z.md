# Phase 11 Benchmark Report

Generated: 2026-11-13T07:06:03.565Z
Mode: live
Dataset: /Users/hwitzthum/rag-system/evaluation/evaluation_queries.generated.json
Corpus fingerprint: `34ec45e9d5b7a0fb006deccfd51c644244111c4721e082f0edd810abb2b0dec3`
Run artifact: /Users/hwitzthum/rag-system/evaluation/runs/benchmark-2026-11-13T07-06-03-565Z.json
Evaluated queries: 118
Generator model: gpt-6-luna
Judge model: claude-opus-5

## Run Configuration

| Setting | Value |
| --- | --- |
| topK | `8` |
| expansion | `false` |
| judge | `true` |
| ignoreExpectedSection | `false` |
| cacheNamespace | `benchmark:2026-11-13T06:37:13.428Z` |
| retrievalConfigFingerprint | `b2af720d45f0` |
| generatorModel | `gpt-6-luna` |
| judgeModel | `claude-opus-5` |
| citationVerifierModel | `gpt-6-sol` |
| queryEmbeddingModel | `text-embedding-3-large` |
| queryEmbeddingDimensions | `1024` |
| retrievalVersion | `1` |
| rrfK | `60` |
| rerankPoolSize | `100` |
| llmMaxOutputTokens | `2000` |
| minEvidenceChunks | `1` |
| minRerankScore | `0.1` |
| minHeuristicRelevance | `0.14` |
| cacheTtlSeconds | `86400` |
| crossEncoderEnabled | `true` |
| crossEncoderModel | `rerank-v3.5` |
| crossEncoderTimeoutMs | `6000` |
| maxChunksPerDocument | `5` |
| diversityRelevanceFloor | `0.125` |
| multiQueryVariations | `3` |
| queryDecompositionEnabled | `true` |
| queryDecompositionMaxSubQueries | `3` |
| evidencePlacement | `ends` |
| citationVerificationEnabled | `true` |
| cragLoopEnabled | `true` |
| evidenceSufficientTop3Mean | `0.214` |
| evidenceSufficientTop3MeanHeuristic | `0.14` |
| cragPromptGuardEnabled | `true` |
| cragReflectionEnabled | `true` |
| cragReflectionMinChecked | `2` |
| cragReflectionMaxUnsupportedShare | `0.5` |
| webSearchEnabled | `false` |
| webMinSources | `2` |

## Summary

| Metric | Value |
| --- | ---: |
| Query count | 118 |
| Evaluated queries | 118 |
| System error count | 0 |
| Answerable / unanswerable | 103 / 15 |
| False answer rate (unanswerable slice) | 0 |
| False abstention rate (answerable slice) | 0.0388 |
| Recall@5 | 0.9612 |
| nDCG@10 | 0.9328 |
| MRR | 0.9177 |
| Citation evidence hit rate | 0.9612 |
| Verified citation rate | 0.9740 (99 verified) |
| Citation accuracy (strict, report-only) | 0.3812 |
| Answer truncation rate | 0 |
| Cache hit rate | 0.9746 |
| Uncached p50 latency (ms) | 4143 |
| Uncached p95 latency (ms) | 5701 |
| Cached p50 latency (ms) | 2702 |
| Cached p95 latency (ms) | 4173 |

## Token-Overlap Grounding (report-only, NOT gated)

Bag-of-words overlap against the chunks that produced the answer. Kept for
continuity only: it measures whether the model quoted its own evidence, which
the system prompt instructs it to do, so it cannot detect an unsupported claim.
Abstentions are excluded rather than scored as perfectly grounded.

| Metric | Value |
| --- | ---: |
| Scored queries (abstentions excluded) | 99 |
| Grounding score | 0.9978 |
| Hallucination rate | 0.0022 |

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
| Judged queries | 103 |
| Faithfulness (GATED) | 0.9951 |
| Answer relevance | 0.9199 |
| Context precision | 0.5740 |
| Context recall | 0.9573 |
| Abstention rate | 0.0388 |

## Threshold Gates

| Metric | Target | Actual | Status |
| --- | --- | ---: | --- |
| Recall@5 | >= 0.85 | 0.9612 | PASS |
| nDCG@10 | >= 0.8 | 0.9328 | PASS |
| Citation evidence hit rate | >= 0.8 | 0.9612 | PASS |
| Verified citation rate | >= 0.9 | 0.9740 | PASS |
| Faithfulness (LLM judge) | >= 0.9 | 0.9951 | PASS |
| False answer rate (unanswerable slice) | <= 0.1 | 0 | PASS |
| False abstention rate (answerable slice) | <= 0.05 | 0.0388 | PASS |
| Cache hit rate | >= 0.3 | 0.9746 | PASS |
| Uncached p50 latency (ms) | < 8000 | 4143 | PASS |
| Uncached p95 latency (ms) | < 15000 | 5701 | PASS |
| Cached p50 latency (ms) | < 7000 | 2702 | PASS |
| Cached p95 latency (ms) | < 12000 | 4173 | PASS |
| Recall@5 [EN] | >= 0.85 | 0.9655 | PASS |
| nDCG@10 [EN] | >= 0.8 | 0.9097 | PASS |
| Recall@5 [DE] | >= 0.85 | 0.9556 | PASS |
| nDCG@10 [DE] | >= 0.8 | 0.9626 | PASS |

## Per-Language Breakdown

| Language | Queries | Recall@5 | nDCG@10 | Citation acc. | Faithfulness | Cache hit | Uncached p95 (ms) | Cached p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| EN | 66 | 0.9655 | 0.9097 | 0.2781 | 1 | 0.9848 | 5918 | 3909 |
| DE | 52 | 0.9556 | 0.9626 | 0.5141 | 0.9889 | 0.9615 | 5045 | 4394 |
| FR | 0 | 0 | 0 | 0 | n/a | 0 | 0 | 0 |
| IT | 0 | 0 | 0 | 0 | n/a | 0 | 0 | 0 |
| ES | 0 | 0 | 0 | 0 | n/a | 0 | 0 | 0 |

## Open Risks

- 21 queries include at least one failure type requiring triage.

## Failure Sample

| Query ID | Language | Failure types |
| --- | --- | --- |
| de-051209e7-30 | DE | cache |
| de-051209e7-32 | DE | citation |
| de-051209e7-4 | DE | grounding |
| de-051209e7-26 | DE | citation |
| en-2e51c566-23 | EN | abstention |
| en-2e51c566-21 | EN | citation, cache |
| de-373a9133-0 | DE | citation |
| de-8f39c1e0-0 | DE | retrieval, citation, citation |
| de-8f39c1e0-14 | DE | citation |
| de-8f39c1e0-22 | DE | abstention |
| de-8f39c1e0-29 | DE | abstention, retrieval, citation |
| de-939ca640-34 | DE | citation |
| de-939ca640-1 | DE | citation |
| de-939ca640-37 | DE | citation |
| de-939ca640-5 | DE | cache |
| en-9d723400-333 | EN | abstention |
| en-9d723400-182 | EN | retrieval, citation |
| en-9d723400-190 | EN | citation |
| en-9d723400-39 | EN | retrieval, citation |
| en-9d723400-201 | EN | citation |
| en-9d723400-319 | EN | citation |

## Release Recommendation

Proceed to release candidate review.
