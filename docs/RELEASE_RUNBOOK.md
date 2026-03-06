# RELEASE_RUNBOOK.md

Version: 1.3  
Date: 2026-03-06

## Purpose

Phase 12 launch runbook with release checklist, rollback plan, and approval gates.

## Preconditions

- all Phase 1-11 checks are complete
- `npm run check` passes
- `npm run test:security` passes
- `npm run eval:benchmark` passes in staging with live providers
- observability config validated (`npm run obs:validate`)
- ingestion cron/backlog health validated (`npm run obs:ingestion:check`)
- staging soak verification validated (`npm run perf:soak:verify`)
- staging/prod release config uses `INGESTION_RUNTIME_MODE=vercel`
- load and resilience checks executed with saved artifacts

## Release Checklist

1. Validate staging env file and credentials:
```bash
cp .env.staging.example .env.staging
npm run infra:check-env:staging
```

Required values in `.env.staging`:

- `INGESTION_RUNTIME_MODE=vercel`
- `CRON_SECRET=<long-random-secret>`

2. Run benchmark and quality gates:
```bash
npm run eval:benchmark
```

3. Run production hardening checks:
```bash
npm run obs:validate
npm run obs:ingestion:check
npm run perf:load -- --base-url https://<staging-host> --token <reader-or-admin-jwt>
npm run perf:resilience -- --base-url https://<staging-host>
npm run perf:soak:verify -- --window-hours 24 --min-completed-jobs 25 --min-ready-documents 25 --max-p95-completion-ms 900000 --max-dead-letter-growth 0 --max-duplicate-write-errors 0
npm run release:readiness
```

Optional one-command execution:

```bash
npm run release:matrix:strict -- --base-url https://<staging-host> --token <reader-or-admin-jwt>
```

4. Review generated artifacts:

- `evaluation/runs/latest.json`
- `evaluation/reports/latest.md`
- `evaluation/performance/load-test-latest.json`
- `evaluation/performance/resilience-latest.json`
- `evaluation/performance/ingestion-health-latest.json`
- `evaluation/performance/staging-soak-latest.json`
- `evaluation/reports/release-readiness-latest.md`
- `evaluation/reports/validation-matrix-strict-latest.json`

5. Collect approvals:

- engineering owner
- security owner
- product owner

## Rollback Plan

1. Immediately stop rollout traffic shift (or redeploy prior Vercel deployment).
2. Switch runtime mode to fallback worker in Vercel env (`INGESTION_RUNTIME_MODE=worker`) and redeploy.
3. Disable cron for `/api/internal/ingestion/run` in Vercel cron management (or redeploy config without the cron entry).
4. Start/verify external `worker/` runtime and confirm it can claim queued jobs.
5. Restore previous environment variable set if changed.
6. If schema migration caused regression, apply pre-validated rollback migration path.
7. Invalidate retrieval cache by incrementing retrieval version only if required by incident response.
8. Confirm service recovery:

- `GET /api/health` healthy
- query endpoint authorization and rate limiter intact
- alert noise stabilized
- queued ingestion jobs begin draining via fallback worker

## Incident Triggers for Rollback

- uncached p95 latency exceeds `7s` sustained
- cached p95 latency exceeds `2.5s` sustained
- citation accuracy drops below `0.90`
- hallucination rate reaches `>= 0.05`
- repeated 5xx query error bursts or provider outage
- sustained ingestion queue growth or repeated cron-run failures

## Post-Rollback Actions

- create incident summary with root cause and timeline
- link remediation tasks before next release candidate
- rerun full benchmark and hardening checks before retry

## Staging Rollback Drill (Mandatory Before Production)

1. In staging, set `INGESTION_RUNTIME_MODE=worker` and redeploy.
2. Disable staging cron for `/api/internal/ingestion/run`.
3. Start fallback worker and process a small queued set (at least 3 jobs).
4. Re-enable `INGESTION_RUNTIME_MODE=vercel`, restore cron, and confirm queue drains again.
5. Save drill evidence (logs + artifact references) in release notes.
