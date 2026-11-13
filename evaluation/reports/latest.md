# Phase 11 Benchmark Report

Generated: 2026-11-13T10:10:44.707Z
Mode: live
Dataset: /Users/hwitzthum/rag-system/evaluation/evaluation_queries.generated.json
Corpus fingerprint: `34ec45e9d5b7a0fb006deccfd51c644244111c4721e082f0edd810abb2b0dec3`
Run artifact: /Users/hwitzthum/rag-system/evaluation/runs/benchmark-2026-11-13T10-10-44-707Z.json
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
| cacheNamespace | `benchmark:2026-11-13T09:41:22.053Z` |
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
| False abstention rate (answerable slice) | 0.0097 |
| Recall@5 | 0.9612 |
| nDCG@10 | 0.9328 |
| MRR | 0.9177 |
| Citation evidence hit rate | 0.9806 |
| Verified citation rate | 0.9748 (102 verified) |
| Citation accuracy (strict, report-only) | 0.3856 |
| Answer truncation rate | 0 |
| Cache hit rate | 0.9915 |
| Uncached p50 latency (ms) | 4228 |
| Uncached p95 latency (ms) | 5724 |
| Cached p50 latency (ms) | 2934 |
| Cached p95 latency (ms) | 4136 |

## Token-Overlap Grounding (report-only, NOT gated)

Bag-of-words overlap against the chunks that produced the answer. Kept for
continuity only: it measures whether the model quoted its own evidence, which
the system prompt instructs it to do, so it cannot detect an unsupported claim.
Abstentions are excluded rather than scored as perfectly grounded.

| Metric | Value |
| --- | ---: |
| Scored queries (abstentions excluded) | 102 |
| Grounding score | 0.9927 |
| Hallucination rate | 0.0073 |

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
| Judged queries | 100 |
| Faithfulness (GATED) | 0.9938 |
| Answer relevance | 0.9489 |
| Context precision | 0.6088 |
| Context recall | 0.9960 |
| Abstention rate | 0.0100 |

## Threshold Gates

| Metric | Target | Actual | Status |
| --- | --- | ---: | --- |
| Recall@5 | >= 0.85 | 0.9612 | PASS |
| nDCG@10 | >= 0.8 | 0.9328 | PASS |
| Citation evidence hit rate | >= 0.8 | 0.9806 | PASS |
| Verified citation rate | >= 0.9 | 0.9748 | PASS |
| Faithfulness (LLM judge) | >= 0.9 | 0.9938 | PASS |
| False answer rate (unanswerable slice) | <= 0.1 | 0 | PASS |
| False abstention rate (answerable slice) | <= 0.05 | 0.0097 | PASS |
| Cache hit rate | >= 0.3 | 0.9915 | PASS |
| Uncached p50 latency (ms) | < 8000 | 4228 | PASS |
| Uncached p95 latency (ms) | < 15000 | 5724 | PASS |
| Cached p50 latency (ms) | < 7000 | 2934 | PASS |
| Cached p95 latency (ms) | < 12000 | 4136 | PASS |
| Recall@5 [EN] | >= 0.85 | 0.9655 | PASS |
| nDCG@10 [EN] | >= 0.8 | 0.9097 | PASS |
| Recall@5 [DE] | >= 0.85 | 0.9556 | PASS |
| nDCG@10 [DE] | >= 0.8 | 0.9626 | PASS |

## Per-Language Breakdown

| Language | Queries | Recall@5 | nDCG@10 | Citation acc. | Faithfulness | Cache hit | Uncached p95 (ms) | Cached p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| EN | 66 | 0.9655 | 0.9097 | 0.2963 | 1 | 0.9848 | 5780 | 4012 |
| DE | 52 | 0.9556 | 0.9626 | 0.5006 | 0.9858 | 1 | 5535 | 4362 |
| FR | 0 | 0 | 0 | 0 | n/a | 0 | 0 | 0 |
| IT | 0 | 0 | 0 | 0 | n/a | 0 | 0 | 0 |
| ES | 0 | 0 | 0 | 0 | n/a | 0 | 0 | 0 |

## Open Risks

- 18 queries include at least one failure type requiring triage.

## Failure Sample

| Query ID | Language | Failure types |
| --- | --- | --- |
| de-051209e7-21 | DE | citation, grounding |
| de-051209e7-4 | DE | grounding |
| en-2e51c566-23 | EN | abstention |
| en-2e51c566-12 | EN | citation |
| en-2e51c566-36 | EN | citation |
| en-2e51c566-21 | EN | citation |
| de-8f39c1e0-0 | DE | retrieval, citation |
| de-8f39c1e0-29 | DE | retrieval |
| de-939ca640-3 | DE | citation |
| en-9d723400-101 | EN | citation |
| en-9d723400-102 | EN | citation |
| en-9d723400-181 | EN | citation |
| en-9d723400-182 | EN | retrieval |
| en-9d723400-108 | EN | citation |
| en-9d723400-265 | EN | cache |
| en-9d723400-190 | EN | citation |
| en-9d723400-39 | EN | retrieval, citation |
| en-9d723400-122 | EN | citation |

## Release Recommendation

Proceed to release candidate review.
