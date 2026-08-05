# RAG_QUALITY_IMPROVEMENT_PLAN.md

Version: 1.2
Date: 2026-08-05
Status: Wave 0 complete (PR #57). Wave 1 complete (2026-08-05) — 1.1/1.3 (PR #60), 1.2 (PR #61), 1.6 (PR #62); 1.4 withdrawn, 1.5 deferred, both on measurement. **Wave 2 complete (2026-08-05)** — 2.1/2.2 shipped as written, 2.3 shipped for tables with the multi-column-reordering half withdrawn on measurement; duplicate document removed; corpus re-ingested and re-measured (EN nDCG@10 +0.068, contextRecall 1.0000, all gated metrics up — see the Wave 2 outcome section). **Wave 3 item 3.1 complete (2026-08-05)** — golden set rebuilt with chunk-id ground truth, corpus-fingerprint envelope, multi-hop + unanswerable slices, per-language gates, and the judge fixes; new zero recorded at `evaluation/runs/benchmark-2026-08-05T14-54-59-370Z.json` (gate FAIL by design: falseAnswerRate 0.333, EN recall/nDCG below floor — see the 3.1 outcome section). **Wave 3 complete (2026-08-05): item 3.2 done (PR #64 + follow-up)** — that first zero turned out to be measured at drifted local config (pool 20 / CE 3000); the production-config zero is `benchmark-2026-08-05T16-22-33-915Z.json` (pool 100 / CE 6000), where only two gates fail: nDCG@10 [EN] 0.705 and falseAnswerRate 0.40 — the single largest open defect, config-independent. Pool 100 re-confirmed on the chunk-id basis; drift baseline re-adopted and verified. See the 3.2 outcome section. **Wave 4 authored (2026-08-05)** — targets the two open gates: item 4.3 promotes the deferred CRAG/Self-RAG loop (trigger met), item 4.2 attacks EN ordering; sequenced instrument → retrieval fixes → calibrate → loop → re-baseline. See the Wave 4 section.

## Objective

Close the gap between the current system and state-of-the-art RAG answer quality. Every item below was derived from a read of the actual code, carries `file:line` citations, and states how the change is measured.

This plan does not propose an architectural rewrite. The retrieval architecture is sound; the losses are concentrated in the last mile (a redaction bug, three truncation ceilings, one dead code path) and in an evaluation harness that cannot detect them.

## Baseline Assessment

What is already correct and should not be re-litigated:

- hybrid retrieval is real — OR-based `build_keyword_tsquery` replaced `websearch_to_tsquery` after measuring that 7/8 queries returned zero keyword rows
- RRF fusion is implemented correctly
- Cohere `rerank-v3.5` is wired with pool-relative `rerankScore` and pool-independent `relevanceScore` kept properly separate
- contextual chunk augmentation is fed into **both** the embedded text and the `tsvector`
- HNSW replaced an IVFFlat index that had been trained on an empty table
- citations are resolved deterministically in post-processing, with index-permutation safety
- the evaluation harness computes a real RAG triad with correct judged/unjudged exclusion

Where the system is losing quality:

- production truncates the cross-encoder pool to 20 candidates (`RAG_RERANK_POOL_SIZE="20"`)
- synthesis is capped at 700 output tokens with no truncation detection
- a PII regex replaces correct figures such as `12 500 000` with `[REDACTED]`, after citations have been attached
- HyDE and the multi-branch fusion path never execute in any default flow
- the gated grounding metric is 35%-bag-of-words self-overlap and has scored 0.000/0.000/0.000/0.004 across four live runs — it cannot fail
- the real NLI-style `faithfulness` and a `contextPrecision` of 0.5625 are printed under a "report-only, not gated" header
- aggregate `recallAt5` of 0.8636 masks EN 0.667 against DE 1.000 — the 0.85 gate passes because German carries it

Estimated total: ~2 engineer-weeks for the full plan; Waves 0 and 1 alone are ~40 hours and carry most of the measurable gain.

## Verification Status

Items 1, 2, 3 and 5 were independently re-verified against the working tree on 2026-08-04:

- the shipped phone regex was executed against sample answers — `"Total: 12 500 000 units shipped."` becomes `"Total: [REDACTED] units shipped."`, and `"Der Betrag betrug 45 000 00 Euro."` becomes `"Der Betrag betrug [REDACTED] Euro."`
- `.env.vercel.production:25` sets `RAG_RERANK_POOL_SIZE="20"` against a default of 40 at `lib/config/env.ts:46`
- `RAG_LLM_MAX_OUTPUT_TOKENS` is 700 at both `lib/config/env.ts:48` and `.env.vercel.production:18`
- `hnsw.ef_search` is set at `supabase/migrations/20260804063819_ranking_core.sql:190`; `iterative_scan` appears nowhere in `supabase/migrations/`

The remaining items are cited but were not re-executed; confirm each citation before implementing.

---

## Wave 0 — Measurement Hygiene

Fix the ruler before measuring anything. Nothing in Wave 1 can be honestly A/B'd until this lands. Take a fresh baseline at the end of this wave and treat it as the new zero.

**Outcome (merged 2026-08-04, PR #57).** 12 of 13 items shipped; the multiplicative contextual-grouping boost was withdrawn after measurement (see 0.1). The new zero is `evaluation/runs/benchmark-2026-08-04T21-15-47-237Z.json`, 10/10 gates pass:

|                          |            Before Wave 0 |                 New zero |
| ------------------------ | -----------------------: | -----------------------: |
| recall@5 / nDCG@10 / MRR | 0.8636 / 0.8168 / 0.8049 | 0.8636 / 0.8168 / 0.8049 |
| faithfulness             |                  ungated | **0.9910 (gated ≥ 0.9)** |
| contextPrecision         |                   0.5625 |                   0.7159 |
| contextRecall            |                   0.9364 |                   0.9625 |

Retrieval metrics are unchanged, as expected once 0.1's ranking change was reverted — Wave 0 shipped no ranking change. The judge metrics moved because the judge now reads full chunk text plus `chunk.context` rather than a 1,500-char excerpt.

**Two carry-overs for Wave 1:**

1. **This baseline is not a production-config number.** It was measured at `rerankPoolSize: 20` / `crossEncoderTimeoutMs: 3000` from `.env.local`; production runs 60 / 6000 after the 0.1 down payment. Re-measure locally at production values before reading item 1.2's sweep against it.
2. **Item 1.1's predicted gain is not there.** The plan expects fixing the PII redaction bug to raise judge `faithfulness` and `answerRelevance`. Faithfulness is already 0.9910 and answerRelevance 0.9543 — under 0.01 of headroom on both, measured with the bug still present. The bug is real and still worth fixing (it ships wrong figures to users, which no metric here captures), but do not schedule it expecting a metric to move. The measurable headroom is EN: recall 0.6667 / nDCG 0.6195 against DE's 1.0 / 0.9534, which is what items 1.2, 1.4 and 2.1 target.

**A note on confidence labels.** Item 0.1's multiplicative boost carried a concrete, plausible justification and still cost 0.044 EN nDCG, because the justification reasoned about raw cross-encoder scores when `rerankScore` is pool-normalised. Lint, typecheck, 250 unit tests and a green build all passed it; only the live benchmark caught it. Items 1.2 and 1.5 are marked "verified" on the same basis — a read of the code, not a measurement. Verify each premise against a run before implementing.

### 0.1 Quick wins

- [x] Set `RAG_RERANK_POOL_SIZE=60` in `.env.vercel.production` (currently `20`). Env-var-only down payment on item 2; raise `RAG_CROSS_ENCODER_TIMEOUT_MS` alongside it and watch the Cohere fallback-warning rate.
- [x] Refuse to write `evaluation/runs/latest.json` and `latest.md` when `mode === "dry-run"` (`scripts/evaluation/run-benchmark.ts:826-837`) — write `latest-dry-run.json` instead — and drop `allow-dry` from `scripts/production/generate-release-readiness.ts:161`. `executeDryRun` fabricates chunks that always contain the expected page (recall 1.000, grounding 1.000), and `npm run release:readiness:precutover` currently accepts that as release-gate input.
- [x] Point `eval:benchmark` at `evaluation/evaluation_queries.generated.json`, or change the default `datasetPath` at `scripts/evaluation/run-benchmark.ts:111`. It currently defaults to the 200-record synthetic fixture whose `expected_document` values (`doc_company_profile`, …) exist nowhere in the corpus.
- [x] Strip out-of-range `[n]` markers from answer prose in `lib/answering/citations.ts:71-75`. The marker is counted and discarded but never removed from the text, so an answer citing `[9]` against 8 chunks ships `[9]` to the user with nothing in the Evidence Navigator to match.
- **WITHDRAWN — implemented, measured, reverted. Do not re-attempt without an nDCG@10 sweep.** ~~Make the contextual-grouping boost multiplicative:~~ `rerankScore: baseScore * (1 + 0.08 * adjacentNeighbourCount)` at `lib/retrieval/contextual-grouping.ts:42`. A flat +0.05/+0.10 is enormous against Cohere's skewed distribution — a chunk scored 0.02 ends at 0.12 and overtakes one the cross-encoder rated 0.11 as genuinely relevant.

  **Measured outcome (2026-08-04):** nDCG@10 fell 0.8168 → 0.7989 and EN 0.6195 → 0.5757; an EN-only re-run after reverting restored both values exactly (recall@5 and DE unchanged throughout). The premise above is wrong for this codebase: `rerankScore` is **pool-normalised** (`lib/contracts/retrieval.ts:27-32`), so top-of-pool candidates sit near 0.95 and an 8% boost is worth ~0.076 there — _larger_ than the flat 0.05 it replaced, and applied exactly where nDCG@10 is measured. The 0.02-scored chunks the item describes sit deep in the pool, not in the ranked output. Artifacts: `evaluation/runs/benchmark-2026-08-04T20-47-41-690Z.json` (multiplicative) vs `-T12-35-17-329Z.json` (before). Reasoning is recorded in `lib/retrieval/contextual-grouping.ts`.

  **What this did expose:** page gaps are compared with `<= 1`, so several chunks retrieved from the _same page_ all boost each other and interior ones in the sort order boost twice. That is the deferred `chunk_index` adjacency-key item at the bottom of this document — no longer speculative. `tests/retrieval.contextual-grouping.test.ts` pins the current behaviour so a fix fails loudly.

- [x] Sort the multi-query merge before RRF: `vectorCandidates = [...chunkMap.values()].sort((a, b) => b.retrievalScore - a.retrievalScore)` at `lib/retrieval/service.ts:254`. The best-score-per-chunk computed at line 249 is stored and then ignored, because `reciprocalRankFusion` derives rank purely from array index (`lib/retrieval/rrf.ts:16`). Latent today (the flag is off in production) but it means `RAG_MULTI_QUERY_ENABLED=true` cannot currently be A/B'd honestly.
- [x] Require at least one alphabetic character in `HEADING_UPPERCASE` (`lib/ingestion/runtime/chunking.ts:11-12`). It matches purely numeric all-caps lines, so a table header row like `2024 2025 2026` is consumed as a section title and silently deleted from the chunk body.
- [x] Delete the unused `prompts/grounded-answer-system.md` (no TypeScript file imports it) and fix `docs/DEVELOPMENT_RUNBOOK.md:203`, which claims the grounded answer templates live in `prompts/`. Two divergent copies of the system prompt is a trap for whoever edits the wrong one.
- [x] Add a `config` block (all `RAG_*` flags, both model names, embedding model and dimensions, retrieval version, topK) to the benchmark run artifact at `scripts/evaluation/run-benchmark.ts:815`. Ten stored runs are currently indistinguishable by configuration.

### 0.2 Config fingerprint in the retrieval cache key

**Impact:** medium · **Effort:** 3h · **Confidence:** verified · **STATUS: DONE**

`buildRetrievalCacheKey` hashes exactly `${normalizedQuery}::${language}::v${retrievalVersion}::k${topK}::scope${scopeKey}::schema${CACHE_KEY_SCHEMA_VERSION}` (`lib/retrieval/trace.ts:14-17`). The ACL dimension is correctly carried by `scopeKey`, but nothing reflects `RAG_CROSS_ENCODER_ENABLED`, `RAG_CROSS_ENCODER_MODEL`, `RAG_RERANK_POOL_SIZE`, `RAG_RRF_K`, `RAG_CONTEXTUAL_GROUPING_ENABLED`, `RAG_MULTI_QUERY_ENABLED`, `RAG_QUERY_EMBEDDING_MODEL` or `RAG_QUERY_EMBEDDING_DIMENSIONS`. The only lever is `RAG_RETRIEVAL_VERSION`, a manually-bumped integer sitting at `1` everywhere, against `RAG_CACHE_TTL_SECONDS=86400`.

**Change:** compute a short sha256 `configFingerprint` over that tuple once at module load in `lib/retrieval/trace.ts` and fold it into the hashed string at line 17. Keep `RAG_RETRIEVAL_VERSION` as the manual corpus-level escape hatch. Expose the fingerprint on `RetrievalTrace` so the audit log records which ranking configuration produced an answer. Give each benchmark run its own cache namespace so the "cached" pass at `run-benchmark.ts:358` measures cache latency rather than a previous configuration's ranking.

**Measure:** no direct ranking gain — this is the prerequisite that makes items 2, 4 and every future sweep measurable at all. Verify by flipping `RAG_CROSS_ENCODER_ENABLED` and confirming the next request returns a different chunk set. Expect one cold-cache latency spike on deploy as every key changes at once.

### 0.3 Make the grounding gate able to fail

**Impact:** high · **Effort:** 10h · **Confidence:** verified · **STATUS: DONE**

Three compounding defects:

1. `hallucinationRate < 0.05` is a release gate, but the metric is bag-of-words overlap against the very chunks that produced the answer (`overlap / statementTokens.length >= 0.35`, `lib/evaluation/metrics.ts:238`) while the system prompt instructs "Prefer direct quotes or close paraphrases from the evidence". It cannot fail, and has not: 0.000/0.000/0.000/0.004 across four live runs, with `groundingScore` 1.000 in three of four. Abstentions return `groundingScore: 1, hallucinationRate: 0` outright.
2. `thresholdChecks` contains ten checks and not one is a judge metric. The report header reads "LLM-Judge Metrics (report-only, not gated)" while the latest live run records `contextPrecision: 0.5625` (DE: 0.370).
3. The judge is the same model as the generator — `RAG_EVAL_JUDGE_MODEL` and `RAG_LLM_MODEL` both default to `gpt-4o-mini` and neither is overridden anywhere — and it sees strictly _less_ evidence than the answerer: `CHUNK_EXCERPT_CHARS = 1_500` against a 700-BPE-token chunk budget (~2800 chars), and `chunk.context`, the contextual augmentation the answerer receives, is never shown to the judge at all.

**Change:**

- [x] Set `RAG_EVAL_JUDGE_MODEL` to a different, stronger family than the generator. `@anthropic-ai/sdk` is already a dependency and a full Anthropic BYOK vault exists at `lib/providers/anthropic-vault.ts`. Assert judge ≠ generator at benchmark start and print both model ids into the report header.
- [x] Give the judge the same rendered evidence the answerer saw (`lib/evaluation/llm-judge.ts:42-63`) — reuse `formatEvidenceChunk` from `lib/answering/prompts.ts` and budget by tokens, not chars.
- [x] Demote `groundingScore` and `hallucinationRate` to report-only, mirroring what was already done for strict `citationAccuracy`. Add `faithfulnessMin` to `BenchmarkThresholds` and a `faithfulness` check to `thresholdChecks`, failing closed when `judgedCount` is 0 — the same pattern already used for `verifiedQueryCount > 0` at `lib/evaluation/metrics.ts:450-454`.
- [x] Stop returning `groundingScore: 1` for abstentions; return null and exclude.

**Measure:** self-measuring. After the change, a prompt regression or model swap that produces unsupported sentences blocks the build instead of shipping green. Expect the first runs to fail while the real faithfulness level is discovered — **do not lower the threshold to fit**. The judge-model swap makes historical judge numbers non-comparable; record it as a baseline reset.

---

## Wave 1 — Answer Quality, No Re-ingest Required

**Phase A — premises measured before implementing (2026-08-05).** Wave 0 closed with an instruction to verify each "verified" item against a run rather than a code read. Doing that first changed the wave: two items were withdrawn on measurement and one had stale arithmetic. The runs below are retrieval-only (`--no-judge`) at production config (`RAG_RERANK_POOL_SIZE=60`, `RAG_CROSS_ENCODER_TIMEOUT_MS=6000`).

**A1 — the production-config baseline** (`evaluation/runs/benchmark-2026-08-05T04-37-06-711Z.json`). Carry-over 1 required this before anything could be A/B'd: the Wave 0 zero was measured at `rerankPoolSize: 20` from `.env.local`, not production's 60.

|          |                  EN |              DE |         Overall |
| -------- | ------------------: | --------------: | --------------: |
| recall@5 | 0.6667 → **0.7222** |       1.0 → 1.0 | 0.8636 → 0.8864 |
| nDCG@10  |     0.6195 → 0.6238 | 0.9534 → 0.9527 | 0.8168 → 0.8182 |
| MRR      |     0.5926 → 0.5810 | 0.9519 → 0.9519 | 0.8049 → 0.8002 |

Pool 20 → 60 buys exactly one EN query of recall (1/18 = 0.056) and nothing in ranking quality — nDCG flat, MRR slightly down. Item 1.2's headroom is therefore much smaller than the plan assumed; see 1.2 below.

**A2 — item 1.4's premise, and its withdrawal** (`benchmark-2026-08-05T04-53-24-485Z.json`). See item 1.4.

| Item                    | Outcome                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| 1.1 PII redaction       | **Shipped** (PR #60). Real defect, but the _email_ pattern, not the phone regex the plan predicted.  |
| 1.3 Output ceiling      | **Shipped** (PR #60).                                                                                |
| 1.2 Pool width          | **Resolved by sweep.** Pool raised 60 → 100; `RAG_CANDIDATE_LIMIT` not built (no depth left to add). |
| 1.4 HyDE auto-fire      | **WITHDRAWN on measurement.** Net-negative on EN and ~2× latency.                                    |
| 1.5 HNSW iterative scan | **DEFERRED on measurement.** Provably inert at current corpus size.                                  |
| 1.6 Prompt contract     | **Shipped** after a judged A/B. Pre-registered criterion tripped; ship argued, not assumed.          |

**Net effect of Phase A on the wave: two items shipped, two withdrawn, one resolved to a one-line config change, one still to be measured.** Four of the six were labelled "Impact: high · Confidence: verified" on a code read. That label meant considerably less than it appeared to.

### 1.1 PII filter redacts correct figures out of finished answers

**SHIPPED — PR #60 (2026-08-05).** Right defect, wrong pattern. The grouped-numeral phone regex is genuinely broken as described, but it does not fire on this corpus. What fires is the **email** pattern: 2 of the 44 baseline answers shipped `Richte das E-Mail an die Adresse [REDACTED]`, deleting the corpus's own contact address out of a procedural answer derived from that same corpus. Both are fixed behind `RAG_PII_REDACTION` (`off | numbers_safe | strict`, default `numbers_safe`).

As Wave 0's carry-over 2 predicted, **no metric moved and none was expected to** — faithfulness was already 0.9910. This is a correctness fix for something no current metric captures. Verified live: the query that produced the redaction now renders `kogu@sa.zh.ch` with `redactionCount: 0`.

**Impact:** high · **Effort:** 4h · **Confidence:** verified (regex executed)

`redactPii` runs on every answer with no config gate. Its phone pattern at `lib/security/output-filter.ts:53` is:

```
/(?<!\d)(?:\+\d{1,3}[-.\s]?)?(?:\(\d{2,4}\)[-.\s]?)?\d{2,4}[-.\s]\d{3,4}[-.\s]\d{2,4}(?:[-.\s]\d{2,4})?(?!\d)/g
```

Executed against real answer text:

| Input                                   | Output                                |
| --------------------------------------- | ------------------------------------- |
| `Total: 12 500 000 units shipped.`      | `Total: [REDACTED] units shipped.`    |
| `The reference number is 2024-1234-56.` | `The reference number is [REDACTED].` |
| `Der Betrag betrug 45 000 00 Euro.`     | `Der Betrag betrug [REDACTED] Euro.`  |

This fires on exactly the content a RAG system exists to surface. Because it runs _after_ `resolveCitedChunks` (`lib/answering/service.ts:280`), the answer still carries a `[n]` marker pointing at a chunk whose number the user is no longer allowed to see. It also poisons the benchmark, which calls `generateGroundedAnswer` directly (`scripts/evaluation/run-benchmark.ts:346`) — the judge sees `[REDACTED]` where a fact should be and scores it unsupported.

**Change:** add `RAG_PII_REDACTION` (`off | numbers_safe | strict`, default `numbers_safe`) to `lib/config/env.ts` and thread it into `filterAnswerOutput` and `redactStreamedSentence`. In `numbers_safe`, drop the generic grouped-numeral phone pattern at line 53 and require an explicit context cue (`tel`, `Tel.`, `phone`, `+CC`). Keep the SSN pattern at line 46 unchanged — it is specific and safe. For emails, pass the attribution chunks (already in scope at `lib/answering/service.ts:278-284`) into `filterAnswerOutput` and redact only addresses absent from the retrieved evidence: an address inside the caller's own RBAC-scoped documents is not a leak. Keep `strict` available and document the mode in the README, which currently documents PII redaction as an active control.

**Measure:** existing harness. Expect judge `faithfulness` and `answerRelevance` to rise on any numeric-heavy corpus, and `citationEvidenceHitRate` to firm up. Re-baseline in the same PR and state the change in the report — current baselines are depressed by this bug, so the delta is a correction, not a regression.

### 1.2 Split retrieval depth from rerank width

**RESOLVED BY SWEEP (2026-08-05): pool raised to 100. `RAG_CANDIDATE_LIMIT` NOT built — see below.**

**The premise arithmetic was stale.** The item computes `candidateLimit` as 32 and concludes only 20 candidates reach rerank. But `candidateLimit = max(topK * 4, env.RAG_RERANK_POOL_SIZE, MIN_CANDIDATE_LIMIT)` (`lib/retrieval/service.ts:234-238`), and Wave 0's item 0.1 had already set `RAG_RERANK_POOL_SIZE="60"` in production — so it was already 60. The "dropping up to 44 fused candidates" figure was true before Wave 0 and not after it.

**The sweep therefore needed no code.** Because `candidateLimit` is derived from `RAG_RERANK_POOL_SIZE`, moving the env var moves depth and width together, so the curve could be measured before deciding whether to build anything. All four points at identical config (`--no-judge`, timeout 6000, `maxOutputTokens` 700):

| EN (18 queries)  | pool 20 | pool 40 | pool 60 |   pool 100 |
| ---------------- | ------: | ------: | ------: | ---------: |
| recall@5         |  0.6667 |  0.7222 |  0.7222 |     0.7222 |
| nDCG@10          |  0.6195 |  0.6033 |  0.6238 | **0.6443** |
| MRR              |  0.5926 |  0.5532 |  0.5810 | **0.6088** |
| overall nDCG@10  |  0.8168 |  0.8098 |  0.8182 | **0.8265** |
| overall MRR      |  0.8049 |  0.7888 |  0.8002 | **0.8116** |
| avg fused pool   |    48.5 |    59.6 |    86.6 |      133.4 |
| p50 latency (ms) |    6142 |    6354 |    5885 |       6247 |

Artifacts: `benchmark-2026-08-04T21-15-47-237Z` (20), `-2026-08-05T05-02-35-712Z` (40), `-T04-37-06-711Z` (60), `-T05-11-11-365Z` (100).

**Reading it honestly.** recall@5 **saturates at pool 40** — widening finds no additional documents. What keeps improving is ordering: nDCG@10 and MRR rise monotonically 40 → 60 → 100 on both the EN slice and the aggregate, which is what a cross-encoder given more candidates should do. Latency is flat throughout, so nothing is traded.

The effect is nonetheless small relative to the noise floor. EN is 18 queries, so 0.02 of nDCG@10 is roughly one query moving one rank, and the pool-40 point sitting _below_ pool 20 shows that scale of movement occurs without a real cause. What makes pool 100 the right pick is not any single pair but that the rise is monotone across three consecutive points on two correlated metrics at no latency cost — **not** that a 0.02 gain has been demonstrated significant on n=18. Treat this as a low-risk configuration choice, not a validated improvement.

**`RAG_CANDIDATE_LIMIT` is not being built.** The knob's purpose is to retrieve deeper than you rerank (or the reverse). At pool 100 the system already fuses an average of 133 distinct candidates out of a 255-chunk corpus — **52% of everything indexed** — before cutting to topK 8. There is no meaningful depth left to add, and no way to measure which half of the coupled change produced the +0.02 when the whole corpus is nearly in the pool already. Building it now would be unmeasurable machinery, the same failure mode as item 1.5.

**Trigger for revisiting:** once the corpus is large enough that a pool of 100 is a small fraction of it (order 10,000+ chunks), depth and width stop being interchangeable and the knob becomes both meaningful and measurable. Note also that `CROSS_ENCODER_POOL_CAP = 100` (`lib/retrieval/cross-encoder.ts:16`) is now **exactly binding** — the pool cannot be raised further without raising it too, or the excess silently keeps heuristic order.

**Not adopted from the original item:** raising `RAG_CROSS_ENCODER_TIMEOUT_MS` was already done in Wave 0 (production is 6000). No Cohere fallback warnings were observed at any sweep point.

#### Follow-up: the contextPrecision drop does not replicate (2026-08-05)

Wave 1 closed with one open question — the `−0.0398` `contextPrecision` drop attributed to pool 100, roughly 4× the noise floor, flagged as "the one merged change I'd want a second judged run to confirm". It was re-run as a clean pair before the Wave 2 re-ingest, since re-ingesting invalidates any A/B against this corpus.

Two judged runs, **same session**, identical config apart from `RAG_RERANK_POOL_SIZE` (judge `claude-opus-5`, generator `gpt-4o-mini`, `maxOutputTokens` 2000, timeout 6000). Artifacts: `benchmark-2026-08-05T06-33-17-912Z.json` (60) and `-T06-50-12-778Z.json` (100).

|                                | pool 60 | pool 100 |   delta |
| ------------------------------ | ------: | -------: | ------: |
| contextPrecision               |  0.6818 |   0.6733 | −0.0085 |
| contextRecall                  |  0.9727 |   0.9727 |       — |
| faithfulness                   |  0.9857 |   0.9836 | −0.0021 |
| answerRelevance                |  0.9455 |   0.9423 | −0.0032 |
| verifiedCitationRate _(gated)_ |  0.9639 |   0.9451 | −0.0187 |
| nDCG@10                        |  0.8182 |   0.8265 | +0.0084 |
| MRR                            |  0.8002 |   0.8116 | +0.0114 |

**The pre-registered criterion was "revert to 60 if pool 100's contextPrecision is more than 0.01 lower". It did not trip: −0.0085.** That is not merely inside the floor — it is _exactly_ the magnitude item 1.6 measured between two runs over byte-identical retrieved chunks. **Pool 100 stays; `.env.vercel.production` is unchanged.**

**Why the original −0.0398 was never a clean pair.** It compared the Wave 0 zero (pool 20) against the item 1.6 treatment run (pool 100) — different sessions, different answer prompts, and a different `maxOutputTokens`. Attributing the whole gap to pool width was not supportable. Measured properly, 60 → 100 costs nothing readable on `contextPrecision` and keeps the nDCG@10 / MRR rise the original sweep found.

**One genuine residual:** `verifiedCitationRate` is 0.0187 lower at pool 100 — about 2× the floor, and a _gated_ metric (both arms pass the 0.9 threshold). One observation, not a trend; worth watching after the Wave 2 re-baseline rather than acting on now.

---

**Original item, for reference:**

**Impact:** high · **Effort:** 3h · **Confidence:** verified

`RAG_RERANK_POOL_SIZE` defaults to 40 (`lib/config/env.ts:46`) but production sets it to 20 (`.env.vercel.production:25`). `candidateLimit = Math.max(topK * 4, env.RAG_RERANK_POOL_SIZE, MIN_CANDIDATE_LIMIT)` = 32 (`lib/retrieval/service.ts:215`), so vector and keyword each return up to 32 and RRF can fuse up to 64 distinct chunks. That pool is handed to `rerankCandidates`, whose first act is `const pool = input.candidates.slice(0, poolSize)` (`lib/retrieval/reranker.ts:120`) — dropping up to 44 fused candidates. Only 20 reach `crossEncoderRerank`, whose own `CROSS_ENCODER_POOL_CAP = 100` is therefore never binding. A 20→8 narrowing gives rerank-v3.5 almost nothing to rescue, and the decision about which candidates the expensive relevance model may consider is made by the cheapest signal in the pipeline.

**Change:** introduce `RAG_CANDIDATE_LIMIT` (default ~60) for `candidateLimit` at `lib/retrieval/service.ts:215-219`, and raise `RAG_RERANK_POOL_SIZE` to 60 in `.env.vercel.production`, `.env.example` and `.github/workflows/ci.yml`. Apply the same to the re-truncation at `lib/retrieval/router.ts:241-244`. Raise `RAG_CROSS_ENCODER_TIMEOUT_MS` (currently 3000) in step — a timeout silently falls back to heuristic order at `lib/retrieval/cross-encoder.ts:79-85`, which would be an invisible quality regression. Sweep 20/40/60/100 and pick on nDCG@10, not latency.

**Measure:** nDCG@10 and MRR. Also log the Cohere fallback-warning rate — a rise means the timeout is now binding and the win is illusory. Must land after item 0.2 or the 24h cache serves pre-change rankings and the A/B reads as a no-op.

### 1.3 Raise the output ceiling and detect truncation

**SHIPPED — PR #60 (2026-08-05).** Default 700 → 2000, matched across `.env.example`, `.env.staging.example`, `.env.vercel.production` and CI. `LlmProvider` now resolves `{ text, truncated }` from `finish_reason === "length"`; `answerTruncated` reaches `retrievalMeta` and renders as a badge; the benchmark records a per-answer `truncated` flag and a run-level `truncationRate`, reported as a **config bug** rather than a quality metric.

Verified live: starving `maxOutputTokens` to 80 sets `answerTruncated: true` on an answer that stops mid-token; the shipped ceiling reports `false`.

Two things the item did not anticipate:

- `trimForSafety`'s 6,000-char cut pushed **no** reason string, so a safety truncation was silently indistinguishable from a finished answer. Raised to 24,000 and given one.
- `hasExcessiveRepetition` returns a **hard refusal** and measured repetition by unique-_line_ ratio. Eight `##` headings plus eight `Limitations` labels across eight substantive sections score 0.42 on that ratio — a refusal for a good answer, and precisely the shape item 1.6's output contract will produce. It now measures by character mass: 0.80 for that answer, 0.14 for a line repeated seven times.

**Impact:** high · **Effort:** 3h · **Confidence:** verified

`RAG_LLM_MAX_OUTPUT_TOKENS` defaults to 700 (`lib/config/env.ts:48`) and is pinned to 700 in production (`.env.vercel.production:18`) and CI. That is roughly 450-500 English words for an 8-chunk multi-document synthesis — a hard ceiling that forces the model to drop evidence, which is precisely what the prompt is trying to prevent. The response type at `lib/providers/defaults.ts:7-16` declares only `choices?: Array<{ message?: { content?: string | null } }>`; `finish_reason` does not exist in the type and nothing reads it on either the blocking or the streaming path. A mid-sentence cut-off answer is shown as finished, written to `query_history`, exported to DOCX/PDF, and fed to the LLM judge — where a truncated final sentence with a dangling `[n]` scores as an unsupported statement, depressing `faithfulness` for a reason unrelated to grounding.

**Change:** raise the default to ~2000-2500 at `lib/config/env.ts:48` and update `.env.example`, `.env.staging.example`, `.env.vercel.production` and `.github/workflows/ci.yml` so CI benchmarks the shipped value. Add `finish_reason` to the response type at `defaults.ts:7-16` and to the streamed chunk parse at `defaults.ts:126-133`, and thread it back through `LlmProvider` as `{ text, truncated }`. On truncation, push a reason into `outputFilter.reasons` and surface an `answerTruncated` flag in `retrievalMeta` and as a badge next to the existing unverified-claims badge. Raise `trimForSafety`'s 6000-char cut (`lib/security/output-filter.ts:172-178`) in the same change or the ceiling just moves, and re-check `hasExcessiveRepetition` (lines 158-170) against real long outputs.

**Measure:** `contextRecall` and `answerRelevance` should rise; add a truncation-rate counter to the benchmark and treat non-zero as a config bug. Watch the p50 <8000ms / p95 <15000ms latency gates — longer answers will pressure them.

### 1.4 Make HyDE and the fusion branches actually fire

**WITHDRAWN — measured, net-negative, not implemented. Do not re-propose without a mechanism fix (see below).**

**Measured outcome (2026-08-05).** The plan correctly said the branch is measurable before any code change, so it was. Run with `--expansion` at production config (`benchmark-2026-08-05T04-53-24-485Z.json`) against the identical run without it (`-T04-37-06-711Z.json`):

|                  | no expansion |                                   expansion |
| ---------------- | -----------: | ------------------------------------------: |
| EN recall@5      |       0.7222 |                                  **0.6667** |
| EN nDCG@10       |       0.6238 |                                      0.6077 |
| DE (all metrics) |            — |                                   unchanged |
| p50 latency      |     5,885 ms |                               **11,226 ms** |
| EN p95 latency   |    11,257 ms | **15,776 ms** (breaches the 15,000 ms gate) |

Expansion did fire — average vector candidates rose 60 → 318 across ~5 branches. It cost 91% p50 latency, lost the single EN query that widening the pool had just gained (`en-2e51c566-11`, recall 1 → 0), and moved DE not at all.

**Mechanism, which is the part worth keeping.** `fuseBranchCandidates` (`lib/retrieval/router.ts:94-126`) fuses each branch's _already-truncated_ output, not each branch's pool: `branchTopK` is `max(topK, min(RAG_RERANK_POOL_SIZE, max(topK*2, 8)))` = 16, so five branches contribute at most 5 × 16 candidates before dedup. Measured average fused pool size **fell from 86.6 to 25.4**. Expansion pays for five retrievals and then hands the cross-encoder a third as many candidates to rank. That is a plausible sufficient cause for the loss, and it means the branch as currently built cannot be net-positive regardless of when it fires — an auto-fire heuristic would only have applied the loss more often.

**If revisited:** fix the fusion first (fuse the branches' full pools, or raise `branchTopK` to the pool size), re-measure, and only then consider a firing heuristic. The latency cost is separate and likely disqualifying on its own against the current gates.

---

**Original item, for reference:**

**Impact:** high · **Effort:** 4h · **Confidence:** verified

The router's only branch is `const shouldExpand = Boolean(input.enableQueryExpansion)` (`lib/retrieval/router.ts:160`). That flag is a per-request user checkbox initialised to `useState(false)` (`components/rag-workbench.tsx:161`), and the dashboard path at `app/api/run/route.ts:76` posts only `{query, topK, enableWebResearch}` — it never sets it at all. HyDE runs exclusively inside that branch (`env.RAG_HYDE_ENABLED ? deps.generateHyde(...) : Promise.resolve(null)`, `router.ts:194`), so despite `RAG_HYDE_ENABLED` defaulting to true and being unset in production (i.e. on), HyDE is dead code in every default flow. The benchmark also defaults `expansion: false` (`scripts/evaluation/run-benchmark.ts:119`), so the harness has never measured it either.

**Change:** replace the flag at `router.ts:160` with `input.enableQueryExpansion ?? shouldAutoExpand(normalizedQuery, language)` and add `shouldAutoExpand` to `lib/retrieval/intent.ts`, extending the existing pattern-based approach there — short/keyword-ish queries and abstract or comparative phrasing, which is where HyDE helps; skip precise entity lookups, where it hurts. Keep the checkbox as an explicit override. Record `queryExpansion.applied` in the trace so the auto-fire rate is observable.

**Measure:** the harness supports `--expansion` today, so the value of the branch is measurable _before_ any code change. Run the 44-query set with and without it, compare recall@5 and nDCG@10 split by language (EN is the weak half at 0.667), and only ship the heuristic if the branch is net-positive.

### 1.5 Enable HNSW iterative scan for filtered queries

**DEFERRED — the premise is false at current corpus size. Do not implement until the trigger condition below is met.**

**Measured (2026-08-05).** The item predicts a scoped question "can receive two or three chunks instead of the requested 32". Calling `public.match_document_chunks` directly against the live database with a document filter:

| Scope                      | Requested | Returned |
| -------------------------- | --------: | -------: |
| single document, 9 chunks  |        32 |        9 |
| single document, 11 chunks |        32 |       11 |
| single document, 12 chunks |        32 |       12 |
| single document, 67 chunks |        32 |   **32** |
| single document, 62 chunks |        60 |   **60** |
| unscoped                   |       200 |  **200** |

Every scoped query returns either the full document or the full requested count. Nothing is being lost. The corpus is 255 chunks across 8 ready documents, so `ef_search = 120` already covers roughly half the table and the planner is very unlikely to be choosing the HNSW index at all — the filter has nothing to subtract from.

Shipping the migration now would mean a schema change on a database **shared with another project** (see `docs/DATABASE_RUNBOOK.md`) in exchange for a provably zero effect, and it would be indistinguishable from a no-op when measured.

**Trigger condition for revisiting:** any single document exceeds ~`ef_search` chunks, or the corpus passes a few thousand chunks _and_ `EXPLAIN ANALYZE` confirms an `Index Scan using idx_document_chunks_embedding_hnsw`. pgvector on the project is **0.8.0**, so `hnsw.iterative_scan` is available whenever it becomes real; the change described below remains correct, it is simply premature.

---

**Original item, for reference:**

**Impact:** high · **Effort:** 3h · **Confidence:** verified

`match_document_chunks` sets `hnsw.ef_search = '120'` (`supabase/migrations/20260804063819_ranking_core.sql:190`) — deliberate and good — but applies `d.status = 'ready'` and `dc.document_id = any(filter_document_ids)` as heap filters _after_ the index scan. `hnsw.iterative_scan` is never set anywhere in the repo. With pgvector's default `iterative_scan = off`, the index returns at most ~`ef_search` tuples and the filter can only subtract. The application always supplies `filter_document_ids` for non-admin users (`resolveAccessibleQueryScope`), and the workbench auto-scopes to a single document right after upload (`components/rag-workbench.tsx:632`). So a question scoped to one document can receive two or three chunks instead of the requested 32 — not a worse ranking, but missing evidence, after which the evidence gate correctly refuses a question the corpus can answer.

**Change:** new migration recreating `public.match_document_chunks` with `set hnsw.iterative_scan = 'relaxed_order'` alongside the existing `set hnsw.ef_search = '120'` — relaxed rather than strict is right here, since results are re-sorted by RRF and the cross-encoder anyway — plus `set hnsw.max_scan_tuples = '40000'` to bound worst-case latency on a very selective filter. Replay the grant statements the existing migration carries at lines 203-205. Optionally rebuild the index as `with (m = 24, ef_construction = 200)` using `create index concurrently` then swap; build cost is one-off and 64 is the floor of pgvector's recommended range.

**Measure:** **not** measurable by the current harness — the benchmark issues unscoped admin queries. Add a scoped-query slice (same questions, `documentIds` set to the single expected document) and gate on recall@5 there; or write `scripts/production/measure-ann-recall.ts` comparing indexed top-40 against exact kNN with `enable_indexscan = off`. Verify with `EXPLAIN ANALYZE` before and after, and check p95.

### 1.6 Rewrite the answer prompt as an output contract

**SHIPPED after a judged A/B (2026-08-05) — but the pre-registered ship criterion tripped, and the decision to ship anyway is argued below rather than assumed.**

Two judged runs at identical config (pool 100, `maxOutputTokens` 2000, judge `claude-opus-5`, generator `gpt-4o-mini`), differing only in the prompt: control `benchmark-2026-08-05T05-31-30-986Z.json`, treatment `-T05-47-47-452Z.json`.

|                                          | control |    contract |
| ---------------------------------------- | ------: | ----------: |
| citationEvidenceHitRate _(gated)_        |  0.8636 |  **0.8864** |
| verifiedCitationRate _(gated)_           |  0.9383 |  **0.9623** |
| contextRecall                            |  0.9682 |      0.9682 |
| faithfulness                             |  0.9858 |      0.9771 |
| answerRelevance                          |  0.9639 |      0.9455 |
| contextPrecision                         |  0.6761 |      0.6676 |
| markerCount / unsupportedStatements      | 371 / 4 | 450 / **9** |
| answers with `##` headings / Limitations |   0 / 0 |     44 / 44 |

Retrieval metrics are identical to four decimals, as they must be — the prompt cannot move retrieval. Both runs pass 10/10 gates.

**The criterion tripped.** It was stated in advance as: ship only if `citationEvidenceHitRate` and `contextRecall` hold or improve **and** `unsupportedStatementCount` does not inflate alongside `markerCount`. Markers rose 21% and unsupported statements more than doubled.

**Why it ships anyway.** The criterion was written to catch one specific failure — marker spam, the model spraying citations to inflate the verifier's denominator without improving grounding. That failure is directly refuted by the data: markers rose **and** `verifiedCitationRate` rose, so the additional markers are accurate rather than padding. The proxy tripped; the thing it was proxying for did not happen.

The unsupported statements are substantially a **measurement artifact of the contract's mandated Limitations section**. All 44 answers now carry one, against 0 before, and **6 of the 9 unsupported statements are negative-existential claims inside it** ("The evidence does not establish the full extent of…"). A faithfulness judge asking "is this statement supported by the retrieved evidence?" marks such a claim unsupported by construction — no chunk can support an assertion about what the chunks omit. Excluding them, unsupported statements go 4 → ~3: flat.

**Judge noise floor, measured for the first time.** `contextPrecision` moved −0.0085 between two runs whose retrieved chunks are byte-identical. That movement is therefore pure judge run-to-run variance, and it establishes a floor of roughly **±0.01** on these metrics. `faithfulness` (−0.0087) sits at that floor and should not be read as a regression. This also retro-informs item 1.2: the −0.0398 `contextPrecision` drop from pool 20 → 100 is ~4× the floor and is probably real.

**What is not explained away.** `answerRelevance` fell 0.0184 — roughly 2× the noise floor — across 26 of 44 queries, with the worst-hit queries being the same ones that gained Limitations sections. Appending a paragraph about what the evidence does _not_ address plausibly dilutes judged directness. This is a genuine cost of the mandatory section, accepted in exchange for the two gated citation metrics and for answers that disclose their own gaps.

**Harness defect this exposes — for Wave 3.** `computeAnswerMetrics`/the LLM judge now sees a sentence type that did not exist in the corpus of answers it was calibrated on. Negative-existential claims should be excluded from faithfulness scoring, or scored against a different question ("does the evidence contradict this?" rather than "does the evidence support this?"). Until then, `faithfulness` is biased slightly downward for every answer with a Limitations section, which is now all of them. Do **not** respond by removing the Limitations requirement to make the metric look better.

**Impact:** high · **Effort:** 5h · **Confidence:** verified

The shipped prompt (`lib/answering/prompts.ts`) says:

- `2. For each claim you make, mentally verify it appears in at least one evidence chunk` — an unobservable internal action, a no-op on a non-reasoning model
- `3. Reference evidence chunks by their chunk index ... so the user can verify your claims` — never makes a marker mandatory per sentence
- `6. Structure the answer clearly with short paragraphs` — zero structural spec, no coverage requirement; combined with the 700-token cap this compounds into systematically thin answers

The verifier then does `.filter((entry) => entry.chunkIndexes.length > 0)` (`lib/answering/verification.ts:56`), so an answer with no markers has a `verifiedCitationRate` of 1.0 by construction — the 0.9 release gate is satisfiable by writing _fewer_ markers.

The eval judge in the same repo is written to the demanding standard ("Cover ALL statements, ALL chunks, and ALL answer points. Never omit array entries.", `lib/evaluation/llm-judge.ts:28`). The production prompt should meet the same bar.

**Change:** rewrite `GROUNDED_ANSWER_SYSTEM_PROMPT` and `WEB_AUGMENTED_SYSTEM_PROMPT` as an explicit output contract — every sentence containing a factual claim MUST end with at least one `[n]` marker; use EVERY evidence chunk that bears on the question; a fixed structure (1-2 sentence direct answer, then `##`-headed sections, then an explicit Limitations section for multi-claim answers); replace "mentally verify" with the observable "before writing a number, name, or date, locate it verbatim in a chunk and cite that chunk"; replace rule 5's vague hedge with a fixed lexicon. Add a verbatim abstention token ("output exactly `INSUFFICIENT_EVIDENCE` and nothing else") and post-process it in `lib/answering/service.ts` into `INSUFFICIENT_EVIDENCE_MESSAGE` with `insufficientEvidence: true`, so model-side abstention gets the same structured treatment the score gate gets — match exactly and strip before it can reach a user.

**Measure:** `citationEvidenceHitRate` (gated at 0.8, currently 0.84 overall but 0.667 on EN) and judge `contextRecall`. Watch `unsupportedStatementCount` alongside `markerCount` — a stricter density rule can push a small model into marker spam that inflates one without improving the other. Land after item 1.3; the structural requirements will not fit in 700 tokens.

---

## Wave 2 — Corpus Rewrite (single re-ingest)

All three items require re-ingestion and item 2.1 additionally requires a full re-embed. Do them **together in one pass** so the corpus is re-embedded exactly once.

Order within the wave matters: PDF extraction changes page text → which changes chunk boundaries → which changes what the context generator sees → which changes the embedded string. Implement in that order, then re-ingest once.

**Status (2026-08-05): COMPLETE.** All three items shipped, the duplicate document was removed, the corpus was re-ingested (three passes — the second and third forced by defects recorded below), and the wave was measured against a judged control arm taken immediately before the first re-ingest. The embedding-drift baseline was re-adopted after failing once by design (centroid cosine 0.0973 vs 0.08).

### Wave 2 outcome — measured

Control arm `benchmark-2026-08-05T07-43-53-326Z` (judged, pool 100, n=40, post-dedup, pre-re-ingest); final treatment `-T13-25-30-604Z` (judged) and `-T13-35-11-164Z` (page-only). Strict retrieval metrics are unreadable across this wave — `expected_section` labels are stale for the re-chunked corpus (strict recall@5 read 0.425 while page-only read 0.950) — so retrieval is reported on the page-only slice and answer quality on the judge, which never touches labels.

| page-only retrieval | control |  final |       delta |
| ------------------- | ------: | -----: | ----------: |
| overall recall@5    |  0.9250 | 0.9500 | **+0.0250** |
| overall nDCG@10     |  0.8587 | 0.8779 | **+0.0192** |
| overall MRR         |  0.8688 | 0.8744 |     +0.0057 |
| **EN recall@5**     |  0.7857 | 0.8571 | **+0.0714** |
| **EN nDCG@10**      |  0.7130 | 0.7806 | **+0.0675** |
| **EN MRR**          |  0.7143 | 0.7602 | **+0.0459** |
| DE nDCG@10          |  0.9371 | 0.9302 |     −0.0068 |
| DE MRR              |  0.9519 | 0.9359 |     −0.0160 |

| judge / gated                     | control |  final |       delta |
| --------------------------------- | ------: | -----: | ----------: |
| contextRecall                     |  0.9700 | 1.0000 | **+0.0300** |
| citationEvidenceHitRate _(gated)_ |  0.9250 | 0.9500 | **+0.0250** |
| faithfulness _(gated)_            |  0.9777 | 0.9868 |     +0.0091 |
| verifiedCitationRate _(gated)_    |  0.9764 | 0.9813 |     +0.0049 |
| answerRelevance                   |  0.9443 | 0.9390 |     −0.0052 |
| contextPrecision                  |  0.6312 | 0.6219 |     −0.0094 |

**The wave is net positive.** EN — the slice items 1.2, 1.4 and 2.1 were all aimed at — gained +0.071 recall@5 and +0.068 nDCG@10, driven by ProDoc (+0.093 nDCG over its 10 queries) and AI_Change (the table document, +0.029). contextRecall reached 1.0000: the retrieved evidence now contains everything needed to answer, on every query. Every gated metric improved. DE gave back ~0.016 MRR, all of it attributable to one document (below). **contextPrecision moved −0.009, inside the noise floor — item 2.2's whole-document context did not measurably improve the metric it was aimed at.** The honest reading: 2.2 is a proven cost fix (the cache works) and a plausible quality fix whose effect this harness cannot resolve at n=40.

**An intermediate run showed faithfulness −0.016 and answerRelevance −0.015; both dissipated on the next re-ingest** (faithfulness ended +0.009 _above_ control). Per-query attribution traced the dip to regenerated answers over re-chunked evidence, concentrated on the document whose retrieval changed most, with the worst-hit answers ending in negative-existential Limitations sentences — the statement type item 1.6 documented as unsupported-by-construction under the current judge. Practical lesson: the measured ±0.01 judge floor holds for byte-identical chunks; once answers regenerate, run-to-run swings of ±0.02 on faithfulness are normal and single-run deltas at that scale should not be read.

**One loss is real and unexplained: `Rollen-Basierte-Arbeit-Redesign.pdf`, −0.22 MRR over its 3 queries.** The adjacent-page merge fix was predicted to recover it and did not (0.5833 → 0.6111 of a 0.8333 control). Chunk granularity is ruled out — control had 11 chunks averaging 69 tokens, final has 12 averaging 68 — so the residual comes from the changed embedded text itself on this extremely sparse deck (812 tokens across 15 pages). Not pursued further: three queries against stale ground truth cannot support another tuning cycle. Revisit under item 3.1 if it persists against chunk-id ground truth.

**Corrections made along the way, kept for the record:** the duplicate-document deletion was predicted to lift EN recall and did not (its measured value is +0.005 EN nDCG / +0.012 MRR — the duplicates ranked above correct evidence rather than displacing it); and the report that item 2.1 took Rollen from 756 to 3,219 tokens was wrong — that was the byte-scrape fallback picking up raw text, and the true figure is 756 → 812 (+7%).

### Corpus audit — the precondition for 2.3

All 8 ready documents were pulled from storage and re-parsed through pdfjs, reading the `x` and `width` fields `assemblePageText` discards:

| Document                          | gapped lines | pages w/ gutter | verdict                                  |
| --------------------------------- | -----------: | --------------: | ---------------------------------------- |
| `20240819_Projektbeschreibungen…` |        31.6% |             2/5 | 2-col key-value form                     |
| `Checkliste_Handbuch_DZ.pdf`      |        34.5% |            8/50 | checkbox glyphs, **not** tables          |
| `AI_Change_Management.pdf`        |         6.6% |           41/62 | real 3-col tables, destroyed             |
| `4_ProDoc Samica II`              |         1.5% |            4/43 | label/body pairs                         |
| `Employee_Wellbeing_AI.pdf`       |         0.7% |             2/8 | true 2-col paper, already reads in order |

Tables are real and damaged; two-column prose is present but already extracts correctly. 2.3 was kept.

### The corpus contains one document twice

`Soak Metric Refresh` (`06da7a75`) is a re-save of `Employee_Wellbeing_AI.pdf` (`32fb0a96`) — different `sha256`, identical extracted text, 22 byte-identical chunks each (verified by `md5(content)`). That is **44 of 255 chunks**, and **8 of the 18 EN golden queries** point at the pair. `isChunkRelevant` requires an exact `documentId` match, so retrieving the twin's identical chunk scores **zero** — a plausible share of the EN recall gap (0.72 against DE 1.00) that has nothing to do with retrieval quality.

Scheduled for deletion as part of the re-ingest, measured on its own first so its effect stays separable from Wave 2's.

### Two defects the re-ingest exposed, neither in the plan

**1. Sections merged across page boundaries, destroying page provenance.** `mergeAdjacentSections` gives a merged section the _first_ section's `pageNumber`, and page number is what citations, the Evidence Navigator and `expected_pages` all key on. Latent until item 2.1 stopped deleting heading lines and left sparse documents with sections small enough to merge end to end: after the first re-ingest, all 5 chunks of `Rollen-Basierte-Arbeit-Redesign.pdf` claimed page 1, so content from page 14 would have been cited as page 1. Both DE recall@5 losses in that run were this one document. Fixed — merging now requires the same page — and pinned by two tests.

**2. pdfjs falls back to byte-scrape silently, and the fallback loses every page number.** Two of seven documents came out of one worker run as `byte_scrape`, which collapses a document to a single page. The job completed, no error was raised, and nothing downstream could tell. It is intermittent: the same two documents parse as `pdfjs` on every attempt from a fresh process, including sequentially alongside the other five, so the cause is unidentified — most likely resource state inside pdfjs in a long-lived worker. `extractPages` now retries once and logs the degradation at error level naming its consequence.

**This one nearly produced a false finding.** The byte-scraped `Rollen-Basierte-Arbeit-Redesign.pdf` reported 756 → 3,219 tokens, which was initially read as item 2.1 restoring deleted headings — a headline result. It was the raw byte-scraper picking up more text. Once extraction was correct the true figure was **756 → 809 tokens (+7%)**. Item 2.1's real effect across the corpus is a 0.3–7% token gain per document. A number that large should have been traced before it was believed.

**Also worth noting:** `run-worker` treats a single failed RPC as fatal — one transient `TypeError: fetch failed` killed the worker mid-session twice. Not fixed here; recorded as a robustness gap.

### Measurement instrument for this wave

- **Judge `contextPrecision` / `contextRecall` are primary.** They are computed from question + retrieved chunks + answer and never touch the dataset labels, so they survive a re-chunk intact.
- **Page-keyed retrieval metrics are secondary.** `expected_pages` does not move.
- **`expected_section` does not survive.** 26 of 44 records carry a real heading, and they carry today's _mangled_ one (`Prozess UnterstüTzungsantrag`, `Mandat ZüRich`, `Pacity Building` — a truncated "Capacity Building"). Item 2.1 stops the recasing that produced those strings, so strict judging fails on 26/44 records for reasons unrelated to retrieval and reads as a collapse that did not happen.

`scripts/evaluation/run-benchmark.ts` therefore gains `--ignore-expected-section`, threaded into `isChunkRelevant`, **defaulting off** so release gates stay strict. It must be applied to both arms of any comparison. Judge noise floor is ±0.01; nothing below that is reported as an effect.

### 2.1 Put headings, titles and sections into the embedded vector

**IMPLEMENTED. Retrieval effect pending the re-ingest.**

All three changes shipped as written: the heading is kept verbatim and pushed as the first element of its section's body, the lowercase/title-case round-trip is gone, sectioning is hoisted to a document-level pass (`splitPagesIntoSections`) that carries the heading path across page boundaries as a `" / "` breadcrumb, and the embedded string is now `title / sectionTitle / context / content`.

**The destructive recasing is worse than the item suggests, and the evaluation set is itself a victim of it.** `expected_section` values in `evaluation/evaluation_queries.generated.json` include `Prozess UnterstüTzungsantrag`, `Mandat ZüRich` and `Pacity Building` — that last one a truncated "Capacity Building". Those labels were generated from the corpus, so the mangling has been propagating into the ground truth. This is why the wave needs `--ignore-expected-section` to be measurable at all, and why item 3.1's regeneration matters more than it looked.

Heading depth comes from an explicit numbering prefix where one exists (`5.4 Mutationen` → depth 2), falling back to all-caps = level 1 and title-case = level 2.

**Measure:** recall@5 and nDCG@10 on the page-only slice, plus judge `contextPrecision`. As the item warns, `centroid_drift_within_limit` fails once by design after the re-embed.

---

**Original item, for reference:**

**Impact:** high · **Effort:** 5h · **Confidence:** verified

In `splitIntoSections` (`lib/ingestion/runtime/chunking.ts:45,57`) a heading line is consumed as the section title and then `continue`d past — it never enters `currentContent` — and it is destructively re-cased with `.toLowerCase().replace(/\b\w/g, ...)`, which mangles acronyms and German compounds. The embedded text is then built as `${item.context}\n\n${item.content}` (`lib/ingestion/runtime/pipeline.ts:481`) — document title and `sectionTitle` appear nowhere in the vector. The heading survives only in `section_title`, which reaches the keyword `tsvector` but not the dense branch, so a query phrased in the heading's own words has to hope the LLM-generated context happened to echo it.

Sectioning is also strictly per page (`pipeline.ts:351`), so a heading on page 3 does not carry to its continuation on page 4, which falls back to the title `Page 4`.

**Change:**

- [ ] In `splitIntoSections`, push the original un-recased heading line as the first element of the new section's `currentContent` while still using it as `sectionTitle`; stop the lowercase/title-case round-trip.
- [ ] Hoist section state to a document-level pass so the heading path persists across page boundaries; store the joined breadcrumb in `sectionTitle`.
- [ ] Make the embedded text deterministic at `pipeline.ts:481`: `${document.title ?? ""}\n${chunk.sectionTitle}\n${item.context}\n\n${item.content}`.

**Measure:** recall@5 and nDCG@10 — but **only after regenerating the golden dataset**. Changing `sectionTitle` to a breadcrumb breaks the `expected_section` substring match at `lib/evaluation/metrics.ts:71-77`, and adding title+section to the embedded text shifts every vector, so the embedding-drift baseline must be re-adopted (`centroid_drift_within_limit` will fail once, by design). Requires a full re-embed.

### 2.2 Feed contextual retrieval the whole document, and fix the dead cache breakpoint

**IMPLEMENTED, and the cache is proven live. Retrieval effect pending the re-ingest.**

The item's premise is confirmed: the minimum cacheable prefix for `claude-haiku-4-5` is **4,096 tokens**, so `cache_control` on the ~45-token `CONTEXT_SYSTEM_PROMPT` never created an entry. Two mechanics the item did not anticipate decide whether the fix saves money or costs a great deal of it:

- **`enrich` runs five chunks concurrently** (`Promise.all` over batches of 5), and a cache entry only becomes readable once the first response begins streaming. Naively, the first batch of every document pays **five** full-document writes. A single `max_tokens: 0` pre-warm request now runs first: it performs prefill, writes the entry, returns an empty content array immediately, and bills no output tokens.
- **`chunksPerRun` is 5**, so a 67-chunk document spans 14 worker runs and the default 5-minute TTL lapses between them. The breakpoint uses `ttl: "1h"`.

**Measured live on `Checkliste_Handbuch_DZ.pdf` (50 pages, 67k chars), enriching 8 chunks:**

```
context_cache_prewarmed  read=     0  write= 25941
context_cache            read= 25941  write=     0   (× 8)
```

One write, eight reads, zero repeat writes — against 9 full-price sends before.

**Two decisions that differ from the item as written:**

- **No new column, and no checkpointing of the document text.** Persisting 50 pages into the `chunk_candidates` JSONB blob bloats every job row, and a new column is a migration on a database **shared with another project**. A resumed run re-downloads and re-extracts instead: seconds, no LLM spend, no schema change.
- **A size window, not an unconditional switch.** Below ~16,000 characters the document cannot cache at all, so sending it per chunk would be pure loss — those documents keep the summary path. Above ~400,000 characters the request is kept clear of the model's context window.

`summarizeDocument`'s excerpt is now head + section outline + tail rather than a flat 6,000-character head slice, so a summary of a fifty-page handbook is no longer a summary of its cover.

**One thing the item did not anticipate:** the model prefixed `**Retrieval Context Summary:**` to every context string, which is concatenated into the embedded text and the tsvector — an identical heading prepended to all 255 vectors. The system prompt now forbids a preamble.

**Cost risk, as flagged:** the acceptance test is `cache_read_input_tokens`. It is logged per chunk as a `context_cache` event. Reads staying at zero means the document is being re-billed per chunk, and the change should be reverted rather than shipped.

---

**Original item, for reference:**

**Impact:** high · **Effort:** 6h · **Confidence:** verified

`summarizeDocument` does `input.text.replace(/\s+/g, " ").trim().slice(0, 6_000)` (`lib/ingestion/runtime/context-generator.ts:255`) — roughly the first page or two — with `max_tokens: 220`, and that single ≤4-sentence summary is the _only_ whole-document signal every chunk's context prompt ever sees. Anthropic's contextual retrieval recipe puts the whole document behind a cache breakpoint. Situating a page-40 contract clause against a summary of page 1 gives the model no way to know which clause, party, or annex it belongs to, so the generated context degenerates toward restating the chunk — the exact failure mode the technique exists to prevent.

Separately, `claudeContext` sets `cache_control: { type: "ephemeral" }` on a ~45-token `CONTEXT_SYSTEM_PROMPT` (`context-generator.ts:79`). The minimum cacheable prefix for `claude-haiku-4-5` is 4,096 tokens, so this never creates a cache entry — no error, `cache_creation_input_tokens: 0`, and full price paid per chunk.

**Change:** pass the extracted page text down from `pipeline.ts` (already in memory at line 330 where it is joined for summarization) into `ContextGenerator.enrich`, and send it as a cached user content block: `content: [{type:"text", text: fullDocumentText, cache_control:{type:"ephemeral"}}, {type:"text", text: chunkPromptBody}]`. Remove the `cache_control` from the system block. Cache the document text alongside `chunk_candidates` so resumed runs reuse it. Keep `summarizeDocument` as the fallback for documents beyond the model's context, but make the excerpt a head+tail sample (first 4,000 + last 2,000 + section-title outline) instead of a flat head slice. Raise `WORKER_CHUNKS_PER_RUN` (currently 5) so more chunks amortize each cache write inside the 5-minute TTL, and log `usage.cache_read_input_tokens` to prove the cache is hit.

**Measure:** existing harness after re-ingest — improves both branches, since context is concatenated into `tsv` as well as the embedding. Chunk boundaries do not change, but stored `context` and embeddings do.

**Cost risk:** if `cache_read_input_tokens` stays 0 (e.g. a document's chunks span worker runs more than 5 minutes apart), the whole document is re-billed per chunk. Fall back to the summary path above a size threshold.

### 2.3 Layout-aware PDF text assembly

**IMPLEMENTED for tables. The multi-column reordering half is WITHDRAWN on measurement — it regressed two real documents and the corpus contains no page that needs it. Do not re-attempt without a page that demonstrates the defect.**

**What the item missed, and it is the main finding.** pdfjs emits table content **cell-major**, not row-major. On `AI_Change_Management.pdf` p14 the y sequence runs 288.3 → 271.7 → 288.3 → 271.7 → 288.3 as the generator finishes each wrapped cell before starting the next column. So the damage was worse than "cells joined by a space": breaking on y _in emission order_ shattered every row into one fragment per cell line, and no amount of within-line gap analysis could have repaired it. Rows are recovered by regrouping items by **baseline**.

**Why reordering was withdrawn.** Baseline regrouping is exactly what breaks side-by-side content: the blocks share baselines, so grouping by y interleaves them. Two real regressions were produced and measured before the scope was narrowed:

- `Employee_Wellbeing_AI.pdf` p5 — a genuine two-column paper, which **already extracts in correct reading order** because the generator emits it column-major. Regrouping interleaved the columns.
- `Rollen-Basierte-Arbeit-Redesign.pdf` p6 — three side-by-side text boxes, merged into `Unklare Verantwortlichkeiten: Bottlenecks durch Personen- Wissen geht verloren (Ferien,`.

A page-level "is this two-column?" detector was tried (band widths, fill ratios, largest backward y-jump) and was not reliable enough to gate on: a footer emitted first produces the same signature as a column break. The shipped scope is therefore deliberately narrow:

> **A page is emitted exactly as the previous assembler emitted it, except that a run of lines proven to be a table is replaced by a Markdown pipe table. Nothing is reordered.**

**Measured across the whole 197-page corpus: 191 pages byte-identical, 6 changed, and all 6 are table substitutions.** Zero regressions.

**Three thresholds that had to be derived from the data, not guessed:**

- **Gap scale is local, not page-level.** A page median glyph advance is dragged up by heading text — a 34-character slide title at ~18pt/glyph against ~6pt body text — and the inflated threshold then swallows a genuine 15pt column gutter as a word space. Both `p14` and `p16` failed to detect until the threshold keyed on the neighbouring glyphs.
- **Column clustering must compare against the cluster centroid.** Chaining against the predecessor let a column drift indefinitely and produced 22 spurious columns for one row of a four-column table.
- **Wrapped rows fold by line spacing.** Cell count cannot distinguish a wrapped row from a new record when every column wraps (`p22`); within-record gaps are ~17pt against ~37pt between records.

Plus a marker guard — a leading `☐`, `•` or `-` is absorbed rather than counted as a column — without which `Checkliste_Handbuch_DZ.pdf` reads as 34.5% tables across 50 pages, and a one-baseline header lookback so a comparison table's blank top-left corner does not strand its column labels and promote the first data row to header.

Downstream, `chunking.ts` now keeps a pipe-row run as a single paragraph, refuses to read a pipe row as a heading, splits an oversized table on row boundaries with the header repeated, and preserves newlines in the relaxed-fallback path.

**Measure:** pending the re-ingest. Only 6 pages change, all in one document, so any corpus-level effect will be small; `contextPrecision` on queries touching that document is where to look.

---

**Original item, for reference:**

**Impact:** medium · **Effort:** 14h · **Confidence:** verified · **Conditional on corpus audit**

`assemblePageText` reads only `item.transform[5]` — the y component — and breaks lines on `Math.abs(y - lastY) > 2` (`lib/ingestion/runtime/pdf-extractor.ts:414-461`). The x coordinate (`transform[4]`) and `item.width` are never read, so everything on a baseline is joined with a single space regardless of horizontal gap.

Two consequences: two-column PDFs whose generators emit items in alternating column order interleave into locally incoherent text that embeds to noise; and a table row's cells, sharing one y, become `Cell A Cell B Cell C` with no delimiter and no header association — after which `paragraphs.push(current.join(" ").replace(/\s+/g, " ").trim())` (`chunking.ts:175`) and `section.text.replace(/\s+/g, " ")` (`chunking.ts:345`) destroy the remaining row boundaries. A number in a table can no longer be attributed to its column or row label. This is the most common source of confidently wrong answers on financial and contractual PDFs, and no amount of reranking can fix it.

**Change:** rewrite `assemblePageText` to collect x, y and width; bucket into lines by y tolerance; within a line sort by x and insert a column separator when the horizontal gap exceeds ~0.5× the median glyph advance; detect multi-column pages by histogramming x-starts and emit column 1 fully before column 2 when a persistent gutter appears across ≥60% of lines; emit ≥3 consecutive lines sharing separator positions as a Markdown pipe table. Then stop destroying it downstream: in `splitIntoParagraphs` treat a table-shaped line as its own paragraph, and never split a table across a chunk boundary (repeat the header row if it exceeds `targetTokens`). Persist a `layout` flag on `ExtractedPage` so provenance records whether reconstruction succeeded, and keep the current single-column path as the fallback.

**Measure:** measurable by the harness only after the golden dataset is regenerated (chunk text and page/section labels shift for every document).

---

## Wave 3 — Golden Dataset and Re-baseline

### 3.1 Rebuild the evaluation dataset

**Impact:** high · **Effort:** 16h · **Confidence:** verified

Do this as the **first step after the Wave 2 re-ingest completes** — not before, or it will be regenerated twice.

The live set (`evaluation/evaluation_queries.generated.json`) is 44 records (EN 18 / DE 26), and zero have more than one expected page — `expected_pages: [chunk.page_number]` (`scripts/evaluation/generate-dataset-from-corpus.ts:251`). There are no unanswerable questions, no multi-hop questions, no adversarial distractors, which is why `abstentionRate` is 0 and can only ever measure _false_ abstention. Section labels are junk carried from extraction ("Page 1", "Pacity Building"), and `isChunkRelevant` requires exact `expected_pages.includes(chunk.pageNumber)` (`lib/evaluation/metrics.ts:59`), so retrieving the semantically correct passage one page over scores zero.

The generator has `chunk.id` in hand and throws it away. The schema has no chunk id, no corpus fingerprint, no generated-at, so a re-chunk silently invalidates the set — **which already happened**: `benchmark-2026-08-04T11-28-14-544Z.json` recorded recall 0.405 on a 37-record set, indistinguishable from a genuine retrieval collapse.

**Change:**

- [x] Extend `EvaluationQueryRecord` with `expected_chunk_ids: string[]` and `question_type: single_hop | multi_hop | unanswerable | adversarial`. Retrieval relevance and citation-evidence hits are chunk-id-exact when ids are present; the page proxy survives only as a fallback for id-less records.
- [x] Wrap the file in an envelope carrying `{corpusFingerprint, generatedAt, generatorModel, records}`. The fingerprint hashes document ids + chunk counts + max chunk `created_at` — not the planned `updated_at`, which does not exist on `document_chunks`; chunk rows are immutable (a re-chunk deletes and re-inserts), so creation time is the freshness signal. `validateEvaluationDataset` rejects bare arrays and the live benchmark refuses a fingerprint mismatch with a regenerate instruction. The generator also re-fingerprints after generation and fails if the corpus moved mid-run.
- [x] Add ~15 unanswerable questions about topics provably absent from the corpus; report and gate `falseAnswerRate` (≤0.1) on that slice alongside `falseAbstentionRate` (≤0.05) on the answerable one. Each question centres on an invented entity whose name is keyword-verified absent from every chunk before the record is accepted. Both rates read the production `insufficientEvidence` flag, so they hold under `--no-judge`. Two generator defects found live: a probe-term filter demanding ≥2 terms when one invented entity is the natural case, and a 1.5k-token cap truncating candidate JSON — both fixed.
- [x] Add a multi-hop slice by prompting the generator with two chunks from different documents. Pairs are over-generated 3× because the LLM refuses unrelated pairs (`feasible: false`); 7 survived.
- [x] Delete the synthetic fixture and the CI test that kept it alive. The fixture and its generator (`scripts/evaluation/generate-dataset.ts`, `eval:dataset:generate`) are gone; `tests/evaluation.metrics.test.ts` was rewritten on inline records rather than deleted — the threshold/fail-closed regression tests are worth keeping, and the point was killing the fixture dependency, which is dead.
- [x] Add **per-language threshold checks** so EN cannot hide behind DE. Recall@5 and nDCG@10 are gated per language at the aggregate floors (0.85/0.8) for every language with ≥5 answerable queries.
- [ ] ~~Add the scoped-query slice needed to verify item 1.5.~~ Item 1.5 was deferred on measurement; the slice is only needed if its trigger condition is ever met.
- [x] **Stop scoring negative-existential claims as unsupported.** Fixed by exclusion: `stripLimitationsSection` (in `lib/evaluation/metrics.ts`, so it stays importable without env side effects) deterministically removes the `## Limitations` section before the judge sees the answer. Headings are matched by localized stem (Limitations/Einschränkungen/Grenzen/…) because answer-contract rule 11 writes headings in the answer's language. Post-processing in code, not a judge-prompt plea.
- [x] **Record the judge noise floor in the report.** `JUDGE_NOISE_FLOOR = 0.01` is stamped into every run artifact and printed as a caveat above the judge table in every report.

**Measure:** self-measuring. Abstention becomes measurable for the first time — today a build that answers everything confidently, hallucinating on out-of-corpus questions, passes every gate. Chunk-id ground truth also upgrades recall@5 from a fuzzy page proxy to an exact-hit metric, removing label noise from the flagship number. Regenerating resets every historical metric; the unanswerable slice will look bad at first — **do not lower the threshold to fit**.

### 3.1 outcome — measured (2026-08-05)

Shipped as written (deviations noted in the checklist above). New dataset: 63 records against fingerprint `7125c124…` — 48 answerable (EN 18 / DE 30; 41 single-hop, 7 multi-hop) + 15 unanswerable (8 EN / 7 DE, every probe term keyword-verified absent). The new zero is `evaluation/runs/benchmark-2026-08-05T14-54-59-370Z.json`. **Gate status: FAIL — by design, and the failures are the findings:**

- **`falseAnswerRate` 0.333 (5/15) vs gate ≤0.1.** The prediction was exact: the system confidently answers a third of questions whose subject matter provably does not exist in the corpus (e.g. the invented "Tech for Good Initiative", "Innovationsförderung 2024"). This was structurally invisible before this item — abstention was 0 on every prior run because nothing unanswerable was ever asked. This is now the top open quality defect; the deferred CRAG/Self-RAG item's trigger condition ("a false-answer number to optimize against") is met.
- **`falseAbstentionRate` 0.0208 (1/48) passes** — the system rarely refuses answerable questions; its failure mode is the opposite.
- **EN gates fail as intended: Recall@5 [EN] 0.778, nDCG@10 [EN] 0.563 vs DE 1.000/0.940.** The aggregate recall (0.917) still passes — exactly the hiding the per-language gates were built to expose. Three of four EN multi-hop questions retrieve only one of two golden chunks (nDCG 0.387–0.613); DE multi-hop is near-perfect.
- **Aggregate nDCG@10 0.7985 vs 0.8** — a hair-fail driven entirely by the EN slice plus the stricter multi-hop ideal (a perfect score now requires _both_ golden chunks ranked).
- **Faithfulness 0.9465 passes** with Limitations sections stripped — first live confirmation that the negative-existential bias, not grounding, was holding the number down.
- Numbers on the chunk-id-exact basis are **not comparable to any earlier run**: the old page proxy sometimes credited a wrong-but-same-page chunk and sometimes zeroed a right-but-page-shifted one. This run is the zero; deltas start here.

### 3.1 addendum — instrument defects found while shipping

- `document_chunks` has no `updated_at`; the fingerprint hashes max `created_at` (chunks are immutable — re-chunks delete + re-insert). Recorded so nobody "fixes" it back.
- The unanswerable generator initially produced 2/15 usable questions: a probe-term filter demanded ≥2 terms when a question built on one invented entity naturally has one, and a 1,500-token cap truncated candidate JSON mid-array (silently parsed as zero candidates). Both fixed; the final run kept 15/15 with zero discards.

### 3.2 Re-baseline

- [x] Re-run the Wave 1 A/Bs against the new corpus to confirm nothing regressed. The re-runnable Wave 1 decision is the 1.2 pool choice (1.1/1.3/1.6 are merged fixes with no coherent "off" arm). Re-run as a clean same-session pair on the chunk-id dataset — see the outcome below. Pool 100 confirmed.
- [x] Re-adopt the embedding-drift baseline. Already done before this item ran: the baseline was refreshed 2026-08-05T13:35Z after the designed post-re-embed failure (`embedding-drift-2026-08-05T08-06-28-479Z.json`, `passed: false`). A fresh live check passes against it — `embedding-drift-2026-08-05T15-36-22-267Z.json`.
- [x] Record the new zero in `evaluation/runs/`. **The zero moved twice.** The first candidate (`benchmark-2026-08-05T14-54-59-370Z.json`) turned out to be measured at `RAG_RERANK_POOL_SIZE=20` / cross-encoder timeout 3000 — `.env.local`, which feeds every local benchmark, had silently drifted from `.env.vercel.production` (100/6000) after the Wave 1 rollout; the item 0.2 config fingerprint in the artifact is what exposed it. `.env.local` is now aligned. **The production-config zero is `benchmark-2026-08-05T16-22-33-915Z.json`** (pool 100, CE timeout 6000, fingerprint `7125c124…`).

### 3.2 outcome — measured (2026-08-05)

**The config drift was most of the "EN collapse."** At the true production config, the failing picture shrinks from four gates to two:

|                 | mislabeled zero (pool 20 / CE 3000) | production zero (pool 100 / CE 6000) |
| --------------- | ----------------------------------: | -----------------------------------: |
| recall@5        |                               0.917 |                            **0.979** |
| nDCG@10         |                       0.7985 (FAIL) |                    **0.8519** (PASS) |
| Recall@5 [EN]   |                        0.778 (FAIL) |                     **0.944** (PASS) |
| nDCG@10 [EN]    |                       0.5627 (FAIL) |       **0.7051** (still FAIL vs 0.8) |
| falseAnswerRate |                        0.333 (FAIL) |        **0.400** (still FAIL vs 0.1) |

Open gates at the production zero: **nDCG@10 [EN]** (0.705 vs 0.8 — EN ordering, the real residual retrieval problem) and **falseAnswerRate** (0.40 — see below).

**The 1.2 pool decision holds on the new basis.** Same-session pair, judge `claude-opus-5`, generator `gpt-4o-mini`, CE timeout 6000 both arms. Artifacts: `benchmark-2026-08-05T16-00-51-540Z.json` (60) and `-T16-22-33-915Z.json` (100):

- recall@5 identical (0.9792) — saturation exactly as the Wave 1 sweep found.
- nDCG@10 +0.0069, MRR +0.0030, EN nDCG +0.0185, citationEvidenceHit +0.0417, contextRecall +0.0146 at pool 100; latency flat. The original pick criterion was nDCG@10 — it still points to 100.
- The Wave 1 residual **resolved**: verifiedCitationRate −0.0015 (was −0.0187), well inside the floor.
- New residual to watch, honestly stated: **contextPrecision −0.0260** at pool 100 — 2.6× the judge floor, larger than the −0.0085 that cleared the pre-registered criterion in Wave 1. Counter-weighed by contextRecall and citation-evidence gains, and contextPrecision is report-only; one observation on n=48, not acted on. If it persists across the next two judged runs, re-open the pool question.
- falseAnswerRate 0.333 → 0.400 is one query flipping on n=15 — abstention behaviour is config-independent, as expected for an answering-policy defect.

**falseAnswerRate is now the single largest open defect** (0.33–0.40 across every configuration measured): the system confidently answers a third or more of questions about entities that provably do not exist in the corpus. Retrieval config cannot fix it; the CRAG/Self-RAG deferral trigger ("a false-answer number to optimize against") is met, and EN ordering (nDCG 0.705) is the retrieval item behind it.

---

## Wave 4 — Answering Policy (CRAG/Self-RAG) and EN Ordering

The two gates Wave 3 left failing, attacked in the order that keeps the measurements honest: **instrument → retrieval fixes → calibrate → loop → re-baseline**. Item 4.2 changes the very scores item 4.3's thresholds read, so the loop is calibrated only after the ordering fixes ship. The sequencing also buys safety margin: the two current false abstentions are the two weakest answerable queries — both EN multi-hop — so fixing EN ordering first widens the falseAbstention headroom (0.0417 vs gate 0.05, one flip of margin on n=48) before the loop tightens policy.

Failure analysis this wave is built on (from the production zero, `benchmark-2026-08-05T16-22-33-915Z.json`):

- **falseAnswerRate 0.40 (6/15).** Every false answer re-labels real corpus content with the invented entity name from the question (e.g. the SaMiCa indicator framework presented as the "Urban Renewal Project's" metrics). None invents facts; all six append a hedging Limitations section instead of refusing. EN worse than DE (4/8 vs 2/7) because one broad EN NGO report lexically matches any generic "project metrics/challenges/outcomes/recommendations" question. Root causes: (1) the evidence gate degenerates to "any one chunk ≥ 0.1 on the Cohere scale" at production config — `RAG_MIN_EVIDENCE_CHUNKS=1` and `RAG_MIN_RERANK_SCORE=0.1`, 2.5× below its own schema default, with no calibration note (`lib/config/env.ts:67`); (2) the model is never shown any evidence-quality signal (`formatEvidenceChunk` emits index/page/section/text only); (3) prompt rule 14 actively biases against abstention (`lib/answering/prompts.ts:40`). The separating signal exists: cross-encoder **top-3 mean relevance separates correct-abstention / false-answer / answerable slices with zero overlap** (unanswerable max 0.294 vs answerable min 0.339 on the stored scale).
- **nDCG@10 [EN] 0.705 (gate 0.8).** Decomposition over the 18 EN answerable queries: EN multi-hop avg 0.443 (4 queries — every one retrieves exactly 1 of 2 golden chunks; the second document is entirely absent from the top-8 in 3 of 4; every missing golden chunk ranks 1–8 in _other_ queries of the same run, so this is ranking budget, not indexing); EN single-hop avg 0.780 (5 queries at exactly 0.6309 — golden at rank 2 behind a near-duplicate same-document sibling; each slip costs 37% of that query's nDCG). Aggravators: the contextual-grouping adjacency boost (+0.05/neighbour, max +0.10, `lib/retrieval/contextual-grouping.ts:17`) is large against observed CE rank gaps of 0.01–0.05 and actively concentrates the top-8 into one document — the opposite of what cross-document multi-hop needs; and the cross-encoder never sees `chunk.context` (`lib/retrieval/cross-encoder.ts:47-49`) even though context is embedded, in the tsvector, and shown to answerer and judge — consistent with the observed score compression (<0.08 spread across a whole top-8 in the worst cases).

### 4.1 Instrumentation prerequisite

**Impact:** enabling · **Effort:** 2h · **Confidence:** verified

The benchmark serializer (`scripts/evaluation/run-benchmark.ts:917-924`) drops `relevanceScore` and `scoreScale` from every stored chunk — but the stored `rerankScore` includes up to +0.10 adjacency boost, so the gate-side (unboosted, absolute) scale is unrecoverable from any artifact. Threshold calibration for 4.3 is impossible until this is fixed. Separately, a cross-encoder timeout silently falls back to heuristic order **and heuristic `scoreScale`**, silently swapping which gate threshold applies, with no trace anywhere.

- [ ] Persist `relevanceScore` and `scoreScale` per serialized chunk in run artifacts.
- [ ] Record per query whether cross-encoder scores actually applied, derived from the chunks' `scoreScale` composition (`cross_encoder` / `heuristic` / `mixed`).
- [ ] No behavior, gate, or fingerprint changes.

**Measure:** self-evident from the next artifact; no metric moves.

### 4.2 EN ordering

**Impact:** high · **Effort:** 10h · **Confidence:** verified (causes measured per query)

Three flag-gated fixes, defaults chosen so production is byte-identical until a flag flips. All four new knobs enter `RETRIEVAL_CONFIG_FINGERPRINT` (sync points: `lib/retrieval/trace.ts` RetrievalConfig + hash fields, `lib/retrieval/service.ts:35-45` wiring, and the "covers every ranking knob" test in `tests/retrieval.core.test.ts`).

- [ ] **CE sees `chunk.context`.** `buildCrossEncoderDocument(chunk, includeContext)`: header = `sectionTitle\ncontext` capped at 1024 chars, content fills to 4096 — the context paragraph carries the document-level disambiguation that distinguishes near-duplicate siblings, so it is never the part truncated away. Env `RAG_CROSS_ENCODER_INCLUDE_CONTEXT` (default false). Fingerprint `cectx:`.
- [ ] **Adjacency boost becomes a knob.** `applyContextualGrouping(chunks, adjacencyBoost)` parametrized, passed from the service; env `RAG_ADJACENCY_BOOST` (default 0.05 = current behavior). At 0.01 the boost is a tie-breaker that can no longer leapfrog a ≥0.03 CE preference, and the pinned same-page mutual-boost defect shrinks proportionally. Fingerprint `adjb:`. The `chunk_index` deferred item stays deferred — attenuation neutralizes the defect it fixes for ~4h less work; it is the pre-registered next lever only if the ladder misses 0.8.
- [ ] **Soft per-document cap on the final topK.** New `lib/retrieval/diversity.ts`, pure function `applyDocumentDiversity(chunks, {topK, maxPerDocument, relevanceFloor})`: greedy order-preserving walk; a document past its cap defers its chunk; a reserved slot is filled only by an alternate-document chunk with `scoreScale === "cross_encoder"` and `relevanceScore ≥ floor` (heuristic-scale overflow chunks are never promoted — their scores are not comparable); if no qualifier exists the slot backfills from the spillover in original order, so single-document queries degrade to a no-op. Scores are never mutated, so evidence-gate readings for surviving chunks are unchanged. Runs after grouping, before the topK slice; the document-overview path bypasses it by construction. Env `RAG_MAX_CHUNKS_PER_DOCUMENT` (default 0 = off), `RAG_DIVERSITY_RELEVANCE_FLOOR` (default 0.25, aligned with the CE gate threshold so promoted chunks are gate-passing). Fingerprints `maxdoc:` / `divfloor:`. No MMR — the cap targets the observed 8-of-8-one-document failure with strictly less machinery.

**Gain budget:** EN = (14 × 0.780 + 4 × 0.443)/18 = 0.705; the gate needs +0.095. Fixing 3 of the 5 rank-2 displacements (+0.369 each) contributes ≈ +0.062 alone; pulling each multi-hop second golden into the top-8 contributes ≈ +0.37 per query on 4 queries. Either family nearly closes the gap; both provide margin. The one rank-7 compressed-band query (`en-2e51c566-54`) rides on the CE-context fix only.

**Measure — A/B ladder,** fresh `--no-judge` control first (fingerprint flips cold the cache), arms strictly sequential on the shipped predecessor stack, criteria pre-registered:

| #   | Arm                       | Knob                                         | Ship criterion                                                                                       |
| --- | ------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | Grouping off (diagnostic) | `RAG_CONTEXTUAL_GROUPING_ENABLED=false`      | Not a ship arm; quantifies adjacency's EN cost / DE benefit. DE drop >0.01 ⇒ Arm 3 uses 0.01, not 0. |
| 2   | CE context                | `RAG_CROSS_ENCODER_INCLUDE_CONTEXT=true`     | EN nDCG ≥ +0.02, DE ≥ 0.930, aggregate recall@5 not down                                             |
| 3   | Adjacency                 | `RAG_ADJACENCY_BOOST=0.01` (fallback 0.02)   | EN nDCG ≥ +0.01, the five 0.6309 queries' golden ranks improve, DE ≥ 0.930                           |
| 4   | Soft cap                  | `RAG_MAX_CHUNKS_PER_DOCUMENT=7` (fallback 6) | EN multi-hop avg nDCG ≥ 0.60, EN single-hop not down >0.01, DE ≥ 0.930; prefer 7 if both pass        |
| 5   | Combined winners          | judged run                                   | All gates incl. nDCG@10 [EN] ≥ 0.8; abstention/faithfulness within noise of the zero                 |

### 4.3 CRAG/Self-RAG adaptive retrieval loop

**Impact:** high (the top open defect) · **Effort:** 14h · **Confidence:** verified (trigger met; separating signal measured)

Retrieve → **assess** (three-way verdict) → **correct** (ambiguous band only) → generate → **reflect**. Promoted out of the deferred table — its trigger condition ("a false-answer number to optimize against") is met, and the correction to its stale row is recorded there. Everything env-flagged; the loop-off arm is bit-identical to baseline (assessment still computed for observability).

- [ ] **Assess** (`lib/answering/policy.ts`): `assessEvidence` — `insufficient` iff `hasSufficientEvidence(...) === false` (called, not reimplemented — the insufficient band is never widened, so gate-driven abstention on answerable queries cannot regress below baseline by construction); `sufficient` iff top-3 mean of `resolveRelevance` ≥ a scale-appropriate threshold (per-chunk-scale mean, mirroring the existing avgThreshold pattern, so mixed-scale cached pools behave); else `ambiguous`. The assessment records `{verdict, top1Relevance, top3MeanRelevance, scale}` — `scale` (`cross_encoder`/`heuristic`/`mixed`) also closes the CE-silent-fallback observability gap at answer time.
- [ ] **Band-scoped prompt guard** (ambiguous only): an evidence-caution block in the _user_ prompt — low retrieval confidence; if the specific named entity/program/document in the question does not appear in the evidence, output exactly `INSUFFICIENT_EVIDENCE`; do not answer about a similar but differently-named entity; do not use this to avoid a partial answer the evidence does support. Global rule 14 is untouched — that is the falseAbstention regression vector. Sufficient-band prompts stay byte-identical.
- [ ] **Entity-term signal** (new `lib/answering/entity-terms.ts`, deterministic, no LLM): quoted phrases + non-sentence-initial capitalized runs from the query, checked against chunk content+context with ≥5-char prefix and substring-in-compound matching (German inflection/compounds must not false-positive). Missing terms are _listed inside the caution block_ — never hard-abstained on.
- [ ] **Reflection gate** (ambiguous only): the already-running citation verification (`lib/answering/verification.ts`, annotate-only today) becomes an abstention gate — if `checkedCount ≥ 2` and `unsupported/checked ≥ 0.5`, return the structured refusal with `outputFilter.reasons: ["reflection_unsupported_citations"]`. Fabricated-entity sentences cite chunks that never mention the entity, so per-sentence entailment fails — high precision at zero added latency. `unverified` fails open. Verifier injectable for tests.
- [ ] **Corrective re-retrieval** (the full-loop stage; built, default-off, own A/B arm): one round of `generateQueryVariations` → full-width merged retrieval via a thin `lib/retrieval/corrective.ts` wrapper reusing the service's merge pattern — **not** the withdrawn `fuseBranchCandidates` — then a single re-assessment. It cannot help fabricated entities (no better evidence exists in the corpus) and risks the p95 gate, so it ships on only if its arm shows falseAbstention/recall gains on ambiguous answerable queries without a latency breach.
- [ ] **Ambiguous-band abstention token leniency:** accept token-prefix answers (`answerBeginsWithAbstentionToken`) as model abstention in the ambiguous band only — under the caution instruction the generator sometimes appends an explanation the whole-string matcher deliberately rejects. Sufficient band keeps strict matching.
- [ ] **Observability:** new `evidenceAssessment` field (verdict, top-1/top-3 relevance, scale, `actionsTaken[]`, loopEnabled) on the answer result, wired into `retrievalMeta`, audit metadata, and per-query benchmark records; flags/thresholds into `RunConfig`. Web-augmented path records the assessment but takes no band actions in v1.
- [ ] **Env flags:** `RAG_CRAG_LOOP_ENABLED` (false, master A/B switch), `RAG_EVIDENCE_SUFFICIENT_TOP3_MEAN` (0.30 — placeholder, documented as uncalibrated until the calibration script runs), `RAG_EVIDENCE_SUFFICIENT_TOP3_MEAN_HEURISTIC` (0.14 = the heuristic gate threshold, so CI and CE-fallback mode classify every gate-passer `sufficient` and the loop no-ops — CI-safe by construction), `RAG_CRAG_PROMPT_GUARD_ENABLED` (true), `RAG_CRAG_REFLECTION_ENABLED` (true), `RAG_CRAG_REFLECTION_MIN_CHECKED` (2), `RAG_CRAG_REFLECTION_MAX_UNSUPPORTED_SHARE` (0.5), `RAG_CRAG_CORRECTIVE_RETRIEVAL_ENABLED` (false). Answering-side flags do not enter the retrieval fingerprint.
- [ ] **Calibration** (new `scripts/evaluation/calibrate-evidence-thresholds.ts`, run after 4.2 ships, on a fresh `--no-judge` run): reads an artifact (requires 4.1 fields), refuses heuristic-contaminated runs, prints three-slice top-1/top-3 tables, recommends `max(unanswerable top-3 mean) + 0.02` clamped below `min(answerable) − 0.01`, hard-fails if the slices overlap. Must be re-run after any ordering-affecting change.

**Measure — A/B protocol** (`--no-judge`, fresh cache namespace per arm, same session): Arm A loop-off baseline; Arm B guard+reflection with calibrated thresholds; Arm B3 corrective-retrieval-on; attribution arms B1 (guard-only) / B2 (reflection-only) only if B misses. **Ship criterion, all must hold:** falseAnswerRate ≤ 0.1 (≤1/15); falseAbstentionRate ≤ 0.05 (≤2/48, no regression); p50 < 8000 / p95 < 15000; answerable recall@5 and citationAccuracy within noise of Arm A (sufficient-band prompts are bit-identical); every falseAnswer→abstention flip attributable via `actionsTaken`, with zero answerable abstentions carrying guard/reflection actions; then one judged run confirming the faithfulness gates before the default flips and production env changes.

### 4.4 Re-baseline

- [ ] Final judged run on the shipped stack recorded as the new zero in `evaluation/runs/`.
- [ ] `.env.vercel.production` and `.env.local` updated **together** (the Wave 3 drift lesson), verified via the artifact config fingerprint.
- [ ] Outcome sections written with measured numbers and residuals honestly stated — including the watched contextPrecision −0.026 residual: if it persists in this wave's judged runs, re-open the pool question per the 3.2 note.

---

## Cross-cutting: the EN/DE split

EN recall@5 is 0.667 against DE's 1.000 in the latest live run, and the 0.85 aggregate gate passes only because German carries it. Add per-language threshold checks as part of item 3.1 and treat EN as the workload actually being optimized — items 1.2, 1.4 and 2.1 all have the most headroom there.

---

## Deferred — reconsider after Wave 3

Each of these was assessed and consciously not scheduled. Reasons are recorded so they are not re-proposed without new information.

| Item                                                                              | Effort | Why deferred                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Switch synthesis to Claude Opus/Sonnet via the existing Anthropic BYOK vault      | 8h     | A cost and latency decision the project owner makes, not an engineering finding. It would also pressure the p50 <8000ms / p95 <15000ms gates, which were honestly calibrated (`lib/evaluation/types.ts:100-118` documents that earlier p95 gates "were only ever passed by dry-run fabrications"). Items 1.1, 1.3 and 1.6 fix things actively breaking the current model's output — a redaction bug, a 700-token cap, and a prompt with no citation contract. Fix those, re-measure, and the swap becomes answerable with a number. The judge half of this was **not** deferred: see item 0.3. |
| `halfvec(3072)` to stop Matryoshka-truncating `text-embedding-3-large`            | 8h     | Technically correct — the column is `vector(1024)`, no `halfvec` anywhere, and pgvector 0.7+ indexes up to 4096 dims at the same 6KB/row as today's 1024-dim fp32. But it needs a full re-embed plus a column-type migration on a database **shared with another project**. Only sensible bundled into the Wave 2 re-embed, and even then A/B 1024-fp32 vs 3072-halfvec before cutover.                                                                                                                                                                                                        |
| ~~Full CRAG/Self-RAG adaptive retrieval loop~~ **→ promoted to Wave 4 item 4.3**  | 18h    | Trigger condition met by item 3.1 (falseAnswerRate 0.33–0.40 is now the top open defect). Two corrections to this row's original text, recorded so history stays honest: (1) "the cheap half shipped as item 1.4" was written while 1.4 was still a proposal — 1.4 was subsequently **withdrawn on measurement** and nothing of the loop ever shipped; (2) the premise-unmeasurable objection is obsolete since the 3.1 unanswerable slice landed.                                                                                                                                             |
| Full CI benchmark job with paired bootstrap regression testing                    | 12h    | Real gap: CI has three jobs and no benchmark, despite `docs/RAG_EVALUATION_FRAMEWORK.md:97-101` promising a smoke benchmark on each main merge. But paired significance testing on n=44 has very limited power, so it must follow item 3.1, and a live CI benchmark needs staging Supabase + OpenAI secrets at ~5 min and real money per PR. The two cheap guards are already in Wave 0.                                                                                                                                                                                                       |
| Boilerplate stripping + MinHash near-duplicate chunk suppression                  | 8h     | Plausible but unmeasured. The strongest cited instance (an all-caps `CONFIDENTIAL` footer promoted to section title on every page) is fixed by the one-line `HEADING_UPPERCASE` guard in Wave 0. The rest is new machinery whose payoff is an undemonstrated `contextPrecision` improvement, with real risk of deleting legitimately repeated content. Revisit if `contextPrecision` stays low after item 1.2 widens the pool and item 3.1 makes the metric trustworthy.                                                                                                                       |
| Online quality signal — thumbs up/down, persisted retrieval trace, failure mining | 14h    | Genuinely valuable long-term. No feedback mechanism exists anywhere; `query_history` stores only query/answer/citations/latency/cache_hit even though the request already computed chunk ids, scores, rerank source and the insufficient-evidence flag and streamed them to the client as `retrievalMeta`. But it moves no metric this quarter, and mining production queries into a committed golden file carries a user-phrasing leak risk. Feeding real failures into an eval harness that cannot fail would only add noise.                                                                |
| Conversational memory / follow-up query contextualization                         | 10h    | The gap is real — the request schema accepts no history, `conversationId` is written and never read back, and `buildGroundedAnswerUserPrompt` takes exactly `{query, language, chunks}`, so "and what about the second one?" embeds to a near-meaningless vector. Deferred on sequencing, not merit: it needs its own multi-turn eval slice, which is the same work as item 3.1 — fold it in there rather than shipping it blind. It also widens the prompt-injection surface by re-entering model-generated text into the prompt.                                                             |
| Extend `Citation` with a supporting quote and per-sentence verdicts               | 8h     | `Citation` carries only `{documentId, pageNumber, chunkId, evidenceIndex}`, so the Evidence Navigator can render only a page number and a truncated uuid, and `verifyCitedStatements` computes a per-sentence verdict array then keeps only counts. But it moves _perceived_ faithfulness, not measured faithfulness, and it changes a metric definition (`computeCitationAccuracy`) mid-flight while Wave 1 is still shifting baselines. The genuinely broken part — dangling out-of-range `[n]` markers — is in Wave 0.                                                                      |
| Contextual grouping: switch adjacency key from `pageNumber` to `chunk_index`      | 4h     | Requires adding a column to two SQL `RETURNS TABLE` signatures plus the `RetrievedChunk` contract, and the claimed benefit (distinguishing genuinely consecutive chunks from two unrelated chunks on a dense page) is speculative with no measurement behind it. Ship the multiplicative-boost fix in Wave 0, measure nDCG@10, then decide whether the key change earns the schema churn.                                                                                                                                                                                                      |

## Provenance

Produced by a five-agent audit workflow on 2026-08-04: four parallel domain auditors (ingestion/indexing, retrieval/ranking, generation/grounding, evaluation/observability) producing 24 raw findings, followed by a verification-and-ranking pass that re-read each citation, rejected 9 findings, and merged the remainder into the 12 items above.
