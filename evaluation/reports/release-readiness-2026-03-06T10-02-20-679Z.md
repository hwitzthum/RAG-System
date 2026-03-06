# Release Readiness Report

Generated: 2026-03-06T10:02:20.679Z
Overall status: FAIL

## Gate Summary

| Gate | Status | Detail |
| --- | --- | --- |
| benchmark_live_gate | FAIL | mode=live, gate=false, systemErrors=200 |
| observability_config_present | PASS | Dashboard and alert configs present. |
| load_test_gate | PASS | mode=dry-run, p95=1880ms, errorRate=0.0050, requests=2400 |
| resilience_gate | PASS | mode=dry-run, checks=3/3 |

## Artifact References

- benchmark run: /Users/hwitzthum/rag-system/evaluation/runs/latest.json
- benchmark report: /Users/hwitzthum/rag-system/evaluation/reports/latest.md
- load test: /Users/hwitzthum/rag-system/evaluation/performance/load-test-latest.json
- resilience checks: /Users/hwitzthum/rag-system/evaluation/performance/resilience-latest.json
