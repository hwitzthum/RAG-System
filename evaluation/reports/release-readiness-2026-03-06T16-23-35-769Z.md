# Release Readiness Report

Generated: 2026-03-06T16:23:35.769Z
Overall status: FAIL

## Gate Summary

| Gate | Status | Detail |
| --- | --- | --- |
| benchmark_live_gate | FAIL | mode=dry-run, required_mode=live, gate=true, systemErrors=0 |
| observability_config_present | PASS | Dashboard and alert configs present. |
| load_test_gate | PASS | mode=dry-run, p95=1880ms, errorRate=0.0050, requests=2400 |
| resilience_gate | PASS | mode=dry-run, checks=3/3 |
| ingestion_health_gate | PASS | mode=live, passed=true, queued=0, stale=0, recentProgress=0 |
| staging_soak_gate | FAIL | mode=live, passed=false, completedJobs=0, readyDocuments=0, stuckProcessing=0 |

## Artifact References

- benchmark run: /Users/hwitzthum/rag-system/evaluation/runs/latest.json
- benchmark report: /Users/hwitzthum/rag-system/evaluation/reports/latest.md
- load test: /Users/hwitzthum/rag-system/evaluation/performance/load-test-latest.json
- resilience checks: /Users/hwitzthum/rag-system/evaluation/performance/resilience-latest.json
- ingestion cron/backlog health: /Users/hwitzthum/rag-system/evaluation/performance/ingestion-health-latest.json
- staging soak verification: /Users/hwitzthum/rag-system/evaluation/performance/staging-soak-latest.json
