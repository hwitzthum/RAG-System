# OBSERVABILITY_RUNBOOK.md

Version: 1.1  
Date: 2026-03-06

## Purpose

Operational setup for Phase 12 observability dashboards and alerts.

## Scope

- dashboard definition for retrieval, latency, cache, grounding, and ingestion health
- alert rules aligned to release gates in `RAG_EVALUATION_FRAMEWORK.md`
- pre-release observability validation workflow

## Source of Truth Files

- `observability/dashboards/rag-system-overview.json`
- `observability/alerts/rag-system-alerts.yaml`

## Dashboard Panels

- query p50/p95 latency and cached p95 latency
- retrieval cache hit rate
- retrieval quality (`Recall@5`, `nDCG@10`, citation accuracy)
- hallucination rate
- ingestion completed/failed/dead-letter counters
- ingestion queue depth and stale-processing counters
- ingestion cron run failure counter
- provider error and timeout rates

## Alert Rules

Configured alert names:

- `query_uncached_p95_latency_high`
- `query_cached_p95_latency_high`
- `retrieval_cache_hit_rate_low`
- `citation_accuracy_low`
- `hallucination_rate_high`
- `provider_error_rate_high`
- `ingestion_dead_letter_detected`
- `ingestion_queue_backlog_high`
- `ingestion_processing_stale_detected`
- `ingestion_cron_run_failures_detected`

## Validation Command

```bash
npm run obs:validate
npm run obs:ingestion:check:dry
# live check (requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
npm run obs:ingestion:check
```

`obs:validate` checks required dashboard metrics and alert rule names.  
`obs:ingestion:check` emits `evaluation/performance/ingestion-health-latest.json` and fails if queue/backlog/cron-progress gates fail.

## Pre-Release Exit Criteria

- dashboard config is committed and validated
- alert config is committed and validated
- alert routing is connected to on-call destination
- no critical alert is firing before rollout

## Notes

- This runbook validates configuration completeness in-repo.
- Cloud wiring (monitoring platform dashboards, webhook channels, pager integrations) must be completed in the target environment.
