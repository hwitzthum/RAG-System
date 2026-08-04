# RAG_QUALITY_IMPROVEMENT_PLAN.md

Version: 1.0
Date: 2026-08-04
Status: Wave 0 complete (merged 2026-08-04, PR #57) — Waves 1-3 not started

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

Highest quality per hour. Land 1.1 first: it is currently depressing the very baselines everything else is measured against.

### 1.1 PII filter redacts correct figures out of finished answers

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

**Impact:** high · **Effort:** 3h · **Confidence:** verified

`RAG_RERANK_POOL_SIZE` defaults to 40 (`lib/config/env.ts:46`) but production sets it to 20 (`.env.vercel.production:25`). `candidateLimit = Math.max(topK * 4, env.RAG_RERANK_POOL_SIZE, MIN_CANDIDATE_LIMIT)` = 32 (`lib/retrieval/service.ts:215`), so vector and keyword each return up to 32 and RRF can fuse up to 64 distinct chunks. That pool is handed to `rerankCandidates`, whose first act is `const pool = input.candidates.slice(0, poolSize)` (`lib/retrieval/reranker.ts:120`) — dropping up to 44 fused candidates. Only 20 reach `crossEncoderRerank`, whose own `CROSS_ENCODER_POOL_CAP = 100` is therefore never binding. A 20→8 narrowing gives rerank-v3.5 almost nothing to rescue, and the decision about which candidates the expensive relevance model may consider is made by the cheapest signal in the pipeline.

**Change:** introduce `RAG_CANDIDATE_LIMIT` (default ~60) for `candidateLimit` at `lib/retrieval/service.ts:215-219`, and raise `RAG_RERANK_POOL_SIZE` to 60 in `.env.vercel.production`, `.env.example` and `.github/workflows/ci.yml`. Apply the same to the re-truncation at `lib/retrieval/router.ts:241-244`. Raise `RAG_CROSS_ENCODER_TIMEOUT_MS` (currently 3000) in step — a timeout silently falls back to heuristic order at `lib/retrieval/cross-encoder.ts:79-85`, which would be an invisible quality regression. Sweep 20/40/60/100 and pick on nDCG@10, not latency.

**Measure:** nDCG@10 and MRR. Also log the Cohere fallback-warning rate — a rise means the timeout is now binding and the win is illusory. Must land after item 0.2 or the 24h cache serves pre-change rankings and the A/B reads as a no-op.

### 1.3 Raise the output ceiling and detect truncation

**Impact:** high · **Effort:** 3h · **Confidence:** verified

`RAG_LLM_MAX_OUTPUT_TOKENS` defaults to 700 (`lib/config/env.ts:48`) and is pinned to 700 in production (`.env.vercel.production:18`) and CI. That is roughly 450-500 English words for an 8-chunk multi-document synthesis — a hard ceiling that forces the model to drop evidence, which is precisely what the prompt is trying to prevent. The response type at `lib/providers/defaults.ts:7-16` declares only `choices?: Array<{ message?: { content?: string | null } }>`; `finish_reason` does not exist in the type and nothing reads it on either the blocking or the streaming path. A mid-sentence cut-off answer is shown as finished, written to `query_history`, exported to DOCX/PDF, and fed to the LLM judge — where a truncated final sentence with a dangling `[n]` scores as an unsupported statement, depressing `faithfulness` for a reason unrelated to grounding.

**Change:** raise the default to ~2000-2500 at `lib/config/env.ts:48` and update `.env.example`, `.env.staging.example`, `.env.vercel.production` and `.github/workflows/ci.yml` so CI benchmarks the shipped value. Add `finish_reason` to the response type at `defaults.ts:7-16` and to the streamed chunk parse at `defaults.ts:126-133`, and thread it back through `LlmProvider` as `{ text, truncated }`. On truncation, push a reason into `outputFilter.reasons` and surface an `answerTruncated` flag in `retrievalMeta` and as a badge next to the existing unverified-claims badge. Raise `trimForSafety`'s 6000-char cut (`lib/security/output-filter.ts:172-178`) in the same change or the ceiling just moves, and re-check `hasExcessiveRepetition` (lines 158-170) against real long outputs.

**Measure:** `contextRecall` and `answerRelevance` should rise; add a truncation-rate counter to the benchmark and treat non-zero as a config bug. Watch the p50 <8000ms / p95 <15000ms latency gates — longer answers will pressure them.

### 1.4 Make HyDE and the fusion branches actually fire

**Impact:** high · **Effort:** 4h · **Confidence:** verified

The router's only branch is `const shouldExpand = Boolean(input.enableQueryExpansion)` (`lib/retrieval/router.ts:160`). That flag is a per-request user checkbox initialised to `useState(false)` (`components/rag-workbench.tsx:161`), and the dashboard path at `app/api/run/route.ts:76` posts only `{query, topK, enableWebResearch}` — it never sets it at all. HyDE runs exclusively inside that branch (`env.RAG_HYDE_ENABLED ? deps.generateHyde(...) : Promise.resolve(null)`, `router.ts:194`), so despite `RAG_HYDE_ENABLED` defaulting to true and being unset in production (i.e. on), HyDE is dead code in every default flow. The benchmark also defaults `expansion: false` (`scripts/evaluation/run-benchmark.ts:119`), so the harness has never measured it either.

**Change:** replace the flag at `router.ts:160` with `input.enableQueryExpansion ?? shouldAutoExpand(normalizedQuery, language)` and add `shouldAutoExpand` to `lib/retrieval/intent.ts`, extending the existing pattern-based approach there — short/keyword-ish queries and abstract or comparative phrasing, which is where HyDE helps; skip precise entity lookups, where it hurts. Keep the checkbox as an explicit override. Record `queryExpansion.applied` in the trace so the auto-fire rate is observable.

**Measure:** the harness supports `--expansion` today, so the value of the branch is measurable _before_ any code change. Run the 44-query set with and without it, compare recall@5 and nDCG@10 split by language (EN is the weak half at 0.667), and only ship the heuristic if the branch is net-positive.

### 1.5 Enable HNSW iterative scan for filtered queries

**Impact:** high · **Effort:** 3h · **Confidence:** verified

`match_document_chunks` sets `hnsw.ef_search = '120'` (`supabase/migrations/20260804063819_ranking_core.sql:190`) — deliberate and good — but applies `d.status = 'ready'` and `dc.document_id = any(filter_document_ids)` as heap filters _after_ the index scan. `hnsw.iterative_scan` is never set anywhere in the repo. With pgvector's default `iterative_scan = off`, the index returns at most ~`ef_search` tuples and the filter can only subtract. The application always supplies `filter_document_ids` for non-admin users (`resolveAccessibleQueryScope`), and the workbench auto-scopes to a single document right after upload (`components/rag-workbench.tsx:632`). So a question scoped to one document can receive two or three chunks instead of the requested 32 — not a worse ranking, but missing evidence, after which the evidence gate correctly refuses a question the corpus can answer.

**Change:** new migration recreating `public.match_document_chunks` with `set hnsw.iterative_scan = 'relaxed_order'` alongside the existing `set hnsw.ef_search = '120'` — relaxed rather than strict is right here, since results are re-sorted by RRF and the cross-encoder anyway — plus `set hnsw.max_scan_tuples = '40000'` to bound worst-case latency on a very selective filter. Replay the grant statements the existing migration carries at lines 203-205. Optionally rebuild the index as `with (m = 24, ef_construction = 200)` using `create index concurrently` then swap; build cost is one-off and 64 is the floor of pgvector's recommended range.

**Measure:** **not** measurable by the current harness — the benchmark issues unscoped admin queries. Add a scoped-query slice (same questions, `documentIds` set to the single expected document) and gate on recall@5 there; or write `scripts/production/measure-ann-recall.ts` comparing indexed top-40 against exact kNN with `enable_indexscan = off`. Verify with `EXPLAIN ANALYZE` before and after, and check p95.

### 1.6 Rewrite the answer prompt as an output contract

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

**Before starting:** audit a sample of the live corpus for tables and two-column layouts. If it has neither, drop item 2.3 and save 14 hours.

### 2.1 Put headings, titles and sections into the embedded vector

**Impact:** high · **Effort:** 5h · **Confidence:** verified

In `splitIntoSections` (`lib/ingestion/runtime/chunking.ts:45,57`) a heading line is consumed as the section title and then `continue`d past — it never enters `currentContent` — and it is destructively re-cased with `.toLowerCase().replace(/\b\w/g, ...)`, which mangles acronyms and German compounds. The embedded text is then built as `${item.context}\n\n${item.content}` (`lib/ingestion/runtime/pipeline.ts:481`) — document title and `sectionTitle` appear nowhere in the vector. The heading survives only in `section_title`, which reaches the keyword `tsvector` but not the dense branch, so a query phrased in the heading's own words has to hope the LLM-generated context happened to echo it.

Sectioning is also strictly per page (`pipeline.ts:351`), so a heading on page 3 does not carry to its continuation on page 4, which falls back to the title `Page 4`.

**Change:**

- [ ] In `splitIntoSections`, push the original un-recased heading line as the first element of the new section's `currentContent` while still using it as `sectionTitle`; stop the lowercase/title-case round-trip.
- [ ] Hoist section state to a document-level pass so the heading path persists across page boundaries; store the joined breadcrumb in `sectionTitle`.
- [ ] Make the embedded text deterministic at `pipeline.ts:481`: `${document.title ?? ""}\n${chunk.sectionTitle}\n${item.context}\n\n${item.content}`.

**Measure:** recall@5 and nDCG@10 — but **only after regenerating the golden dataset**. Changing `sectionTitle` to a breadcrumb breaks the `expected_section` substring match at `lib/evaluation/metrics.ts:71-77`, and adding title+section to the embedded text shifts every vector, so the embedding-drift baseline must be re-adopted (`centroid_drift_within_limit` will fail once, by design). Requires a full re-embed.

### 2.2 Feed contextual retrieval the whole document, and fix the dead cache breakpoint

**Impact:** high · **Effort:** 6h · **Confidence:** verified

`summarizeDocument` does `input.text.replace(/\s+/g, " ").trim().slice(0, 6_000)` (`lib/ingestion/runtime/context-generator.ts:255`) — roughly the first page or two — with `max_tokens: 220`, and that single ≤4-sentence summary is the _only_ whole-document signal every chunk's context prompt ever sees. Anthropic's contextual retrieval recipe puts the whole document behind a cache breakpoint. Situating a page-40 contract clause against a summary of page 1 gives the model no way to know which clause, party, or annex it belongs to, so the generated context degenerates toward restating the chunk — the exact failure mode the technique exists to prevent.

Separately, `claudeContext` sets `cache_control: { type: "ephemeral" }` on a ~45-token `CONTEXT_SYSTEM_PROMPT` (`context-generator.ts:79`). The minimum cacheable prefix for `claude-haiku-4-5` is 4,096 tokens, so this never creates a cache entry — no error, `cache_creation_input_tokens: 0`, and full price paid per chunk.

**Change:** pass the extracted page text down from `pipeline.ts` (already in memory at line 330 where it is joined for summarization) into `ContextGenerator.enrich`, and send it as a cached user content block: `content: [{type:"text", text: fullDocumentText, cache_control:{type:"ephemeral"}}, {type:"text", text: chunkPromptBody}]`. Remove the `cache_control` from the system block. Cache the document text alongside `chunk_candidates` so resumed runs reuse it. Keep `summarizeDocument` as the fallback for documents beyond the model's context, but make the excerpt a head+tail sample (first 4,000 + last 2,000 + section-title outline) instead of a flat head slice. Raise `WORKER_CHUNKS_PER_RUN` (currently 5) so more chunks amortize each cache write inside the 5-minute TTL, and log `usage.cache_read_input_tokens` to prove the cache is hit.

**Measure:** existing harness after re-ingest — improves both branches, since context is concatenated into `tsv` as well as the embedding. Chunk boundaries do not change, but stored `context` and embeddings do.

**Cost risk:** if `cache_read_input_tokens` stays 0 (e.g. a document's chunks span worker runs more than 5 minutes apart), the whole document is re-billed per chunk. Fall back to the summary path above a size threshold.

### 2.3 Layout-aware PDF text assembly

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

- [ ] Extend `EvaluationQueryRecord` with `expected_chunk_ids: string[]` and `question_type: single_hop | multi_hop | unanswerable | adversarial`.
- [ ] Wrap the file in an envelope carrying `{corpusFingerprint, generatedAt, generatorModel, records}`, where the fingerprint hashes document ids + chunk counts + max chunk `updated_at`. Make `validateEvaluationDataset` and the benchmark refuse to run on a fingerprint mismatch.
- [ ] Add ~15 unanswerable questions about topics provably absent from the corpus; report and gate `falseAnswerRate` on that slice alongside `falseAbstentionRate` on the answerable one.
- [ ] Add a multi-hop slice by prompting the generator with two chunks from different documents.
- [ ] Delete the synthetic fixture and the CI test at `tests/evaluation.metrics.test.ts` that keeps it alive.
- [ ] Add **per-language threshold checks** so EN cannot hide behind DE.
- [ ] Add the scoped-query slice needed to verify item 1.5.

**Measure:** self-measuring. Abstention becomes measurable for the first time — today a build that answers everything confidently, hallucinating on out-of-corpus questions, passes every gate. Chunk-id ground truth also upgrades recall@5 from a fuzzy page proxy to an exact-hit metric, removing label noise from the flagship number. Regenerating resets every historical metric; the unanswerable slice will look bad at first — **do not lower the threshold to fit**.

### 3.2 Re-baseline

- [ ] Re-run the Wave 1 A/Bs against the new corpus to confirm nothing regressed.
- [ ] Re-adopt the embedding-drift baseline (`centroid_drift_within_limit` fails once by design after the re-embed).
- [ ] Record the new zero in `evaluation/runs/`.

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
| Full CRAG/Self-RAG adaptive retrieval loop                                        | 18h    | `hasSufficientEvidence` already computes exactly the signal a retrieve→assess→re-retrieve loop needs, then throws it away on refusal. But the premise — that `INSUFFICIENT_EVIDENCE` fires on answerable questions — is currently unmeasurable, because the golden set has zero unanswerable questions and `abstentionRate` is structurally 0. Revisit once item 3.1 provides a false-abstention number to optimize against. The cheap half shipped as item 1.4.                                                                                                                               |
| Full CI benchmark job with paired bootstrap regression testing                    | 12h    | Real gap: CI has three jobs and no benchmark, despite `docs/RAG_EVALUATION_FRAMEWORK.md:97-101` promising a smoke benchmark on each main merge. But paired significance testing on n=44 has very limited power, so it must follow item 3.1, and a live CI benchmark needs staging Supabase + OpenAI secrets at ~5 min and real money per PR. The two cheap guards are already in Wave 0.                                                                                                                                                                                                       |
| Boilerplate stripping + MinHash near-duplicate chunk suppression                  | 8h     | Plausible but unmeasured. The strongest cited instance (an all-caps `CONFIDENTIAL` footer promoted to section title on every page) is fixed by the one-line `HEADING_UPPERCASE` guard in Wave 0. The rest is new machinery whose payoff is an undemonstrated `contextPrecision` improvement, with real risk of deleting legitimately repeated content. Revisit if `contextPrecision` stays low after item 1.2 widens the pool and item 3.1 makes the metric trustworthy.                                                                                                                       |
| Online quality signal — thumbs up/down, persisted retrieval trace, failure mining | 14h    | Genuinely valuable long-term. No feedback mechanism exists anywhere; `query_history` stores only query/answer/citations/latency/cache_hit even though the request already computed chunk ids, scores, rerank source and the insufficient-evidence flag and streamed them to the client as `retrievalMeta`. But it moves no metric this quarter, and mining production queries into a committed golden file carries a user-phrasing leak risk. Feeding real failures into an eval harness that cannot fail would only add noise.                                                                |
| Conversational memory / follow-up query contextualization                         | 10h    | The gap is real — the request schema accepts no history, `conversationId` is written and never read back, and `buildGroundedAnswerUserPrompt` takes exactly `{query, language, chunks}`, so "and what about the second one?" embeds to a near-meaningless vector. Deferred on sequencing, not merit: it needs its own multi-turn eval slice, which is the same work as item 3.1 — fold it in there rather than shipping it blind. It also widens the prompt-injection surface by re-entering model-generated text into the prompt.                                                             |
| Extend `Citation` with a supporting quote and per-sentence verdicts               | 8h     | `Citation` carries only `{documentId, pageNumber, chunkId, evidenceIndex}`, so the Evidence Navigator can render only a page number and a truncated uuid, and `verifyCitedStatements` computes a per-sentence verdict array then keeps only counts. But it moves _perceived_ faithfulness, not measured faithfulness, and it changes a metric definition (`computeCitationAccuracy`) mid-flight while Wave 1 is still shifting baselines. The genuinely broken part — dangling out-of-range `[n]` markers — is in Wave 0.                                                                      |
| Contextual grouping: switch adjacency key from `pageNumber` to `chunk_index`      | 4h     | Requires adding a column to two SQL `RETURNS TABLE` signatures plus the `RetrievedChunk` contract, and the claimed benefit (distinguishing genuinely consecutive chunks from two unrelated chunks on a dense page) is speculative with no measurement behind it. Ship the multiplicative-boost fix in Wave 0, measure nDCG@10, then decide whether the key change earns the schema churn.                                                                                                                                                                                                      |

## Provenance

Produced by a five-agent audit workflow on 2026-08-04: four parallel domain auditors (ingestion/indexing, retrieval/ranking, generation/grounding, evaluation/observability) producing 24 raw findings, followed by a verification-and-ranking pass that re-read each citation, rejected 9 findings, and merged the remainder into the 12 items above.
