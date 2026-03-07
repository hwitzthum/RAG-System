# Task: Parallel Review, Hardening, Shared Rate Limiting, And Limiter Observability

## Assumptions
- Preserve core RAG behavior and product flow.
- Prioritize low-risk changes with clear quality, security, and UX upside.
- Use Supabase as the shared coordination layer for multi-instance rate limiting.
- Emit structured logs for metrics and optionally forward them to a configured HTTPS sink.
- Use the production deployment as the default internal metrics sink target for Vercel environments.

## Plan
- [x] Review the codebase from three perspectives: correctness, technical debt/efficiency, and UX/security.
- [x] Select the highest-value changes with minimal regression risk.
- [x] Harden upload validation for malformed or disguised files.
- [x] Improve client IP extraction for audit and rate-limit inputs.
- [x] Improve query streaming UX so active requests can be canceled cleanly.
- [x] Replace the in-memory query limiter with a shared Supabase-backed limiter.
- [x] Add migration validation coverage for the shared limiter schema and RPC.
- [x] Add limiter observability and blocked-request audit metadata.
- [x] Add an internal metrics ingestion endpoint backed by Supabase.
- [x] Activate metrics sink forwarding in Vercel and verify ingestion end to end.
- [x] Verify with lint, typecheck, migration validation, observability validation, and the TypeScript test suite.

## Review
- Code reviewer: query streaming treated an incomplete SSE stream as success; upload validation trusted file name and MIME alone.
- Devil's advocate: security signals were built on unsanitized forwarded headers, session reset paths left stale console state behind, and in-memory rate limiting would not hold across multiple instances.
- UX and security: operators needed an explicit way to stop long-running streams, sensitive inputs should discourage autofill, and rate limiting needed a shared backend plus observability to behave predictably in production.

## Implemented
- Added IP normalization and safer header parsing in `lib/security/request.ts`.
- Added PDF metadata and file-signature validation in `app/api/upload/route.ts` and shared helpers in `lib/ingestion/upload-helpers.ts`.
- Added query abort handling, incomplete-stream detection, and safer session reset behavior in `components/rag-workbench.tsx`.
- Replaced the local limiter with a shared Supabase RPC-backed limiter in `lib/security/rate-limit.ts` and `app/api/query/route.ts`.
- Added the phase 13 migration for shared rate limiting in `supabase/migrations/202603070001_phase13_shared_rate_limit.sql`.
- Added the phase 13 migration for metrics ingestion in `supabase/migrations/202603070002_phase13_metrics_ingestion.sql`.
- Added structured metric logging for rate-limit allow/block/backend-failure signals in `lib/observability/metrics.ts`.
- Added an authenticated internal sink endpoint in `app/api/internal/observability/metrics/route.ts` that persists metrics to `metric_events`.
- Extended dashboard, alerts, health output, runbooks, and optional HTTPS sink forwarding to cover shared limiter operations and metrics ingestion activation.
- Updated generated DB typing, migration validation, observability validation, focused tests, and rollout examples.

## Rollout
- [x] Applied `202603070001_phase13_shared_rate_limit.sql` to the linked Supabase project.
- [x] Applied `202603070002_phase13_metrics_ingestion.sql` to the linked Supabase project.
- [x] Configured `OBSERVABILITY_METRICS_SINK_URL`, `OBSERVABILITY_METRICS_SINK_AUTH_TOKEN`, and `OBSERVABILITY_METRICS_SINK_TIMEOUT_MS` in Vercel for `production`, `preview`, and `development`.
- [x] Deployed the updated application to production and confirmed the `rag-system-xi.vercel.app` alias.
- [x] Verified `/api/health` reports `observability.metricsSinkConfigured = true`.
- [x] Verified a live `monitoring.activation.test` metric POST returns `202 Accepted` and persists in Supabase.

## Verification
- [x] `npm run lint`
- [x] `npx tsc --noEmit --tsBuildInfoFile /tmp/rag-system.tsbuildinfo`
- [x] `npm run db:validate:migrations`
- [x] `npm run infra:check-env:staging`
- [x] `npm run obs:validate`
- [x] `npm run test:security`
- [x] Remote Supabase verification for `rate_limit_buckets`, `consume_rate_limit(...)`, and `metric_events`
- [x] Production verification for `/api/health` and `/api/internal/observability/metrics`
