# RELEASE_RUNBOOK.md

Version: 1.0  
Date: 2026-03-06

## Purpose

Phase 12 launch runbook with release checklist, rollback plan, and approval gates.

## Preconditions

- all Phase 1-11 checks are complete
- `npm run check` passes
- `npm run test:security` passes
- `npm run eval:benchmark` passes in staging with live providers
- observability config validated (`npm run obs:validate`)
- load and resilience checks executed with saved artifacts

## Release Checklist

1. Validate staging env file and credentials:
```bash
cp .env.staging.example .env.staging
npm run infra:check-env:staging
```

2. Run benchmark and quality gates:
```bash
npm run eval:benchmark
```

3. Run production hardening checks:
```bash
npm run perf:load -- --base-url https://<staging-host> --token <reader-or-admin-jwt>
npm run perf:resilience -- --base-url https://<staging-host>
npm run release:readiness
```

4. Review generated artifacts:

- `evaluation/runs/latest.json`
- `evaluation/reports/latest.md`
- `evaluation/performance/load-test-latest.json`
- `evaluation/performance/resilience-latest.json`
- `evaluation/reports/release-readiness-latest.md`

5. Collect approvals:

- engineering owner
- security owner
- product owner

## Rollback Plan

1. Immediately stop rollout traffic shift (or redeploy prior Vercel deployment).
2. Revert to last approved deployment artifact.
3. Restore previous environment variable set if changed.
4. If schema migration caused regression, apply pre-validated rollback migration path.
5. Invalidate retrieval cache by incrementing retrieval version only if required by incident response.
6. Confirm service recovery:

- `GET /api/health` healthy
- query endpoint authorization and rate limiter intact
- alert noise stabilized

## Incident Triggers for Rollback

- uncached p95 latency exceeds `7s` sustained
- cached p95 latency exceeds `2.5s` sustained
- citation accuracy drops below `0.90`
- hallucination rate reaches `>= 0.05`
- repeated 5xx query error bursts or provider outage

## Post-Rollback Actions

- create incident summary with root cause and timeline
- link remediation tasks before next release candidate
- rerun full benchmark and hardening checks before retry

