#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const dashboardPath = path.join(ROOT, "observability", "dashboards", "rag-system-overview.json");
const alertsPath = path.join(ROOT, "observability", "alerts", "rag-system-alerts.yaml");

const requiredDashboardMetrics = [
  "query_latency_ms_p95",
  "cached_query_latency_ms_p95",
  "retrieval_cache_hit_rate",
  "retrieval_recall_at_5",
  "retrieval_ndcg_at_10",
  "citation_accuracy",
  "hallucination_rate",
  "provider_error_rate",
  "provider_timeout_rate",
  "ingestion_jobs_dead_letter",
  "ingestion_jobs_queued",
  "ingestion_jobs_processing_stale",
  "ingestion_cron_run_failures",
];

const requiredAlertNames = [
  "query_uncached_p95_latency_high",
  "query_cached_p95_latency_high",
  "retrieval_cache_hit_rate_low",
  "citation_accuracy_low",
  "hallucination_rate_high",
  "provider_error_rate_high",
  "ingestion_dead_letter_detected",
  "ingestion_queue_backlog_high",
  "ingestion_processing_stale_detected",
  "ingestion_cron_run_failures_detected",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!fs.existsSync(dashboardPath)) {
  fail(`Missing dashboard config: ${dashboardPath}`);
}

if (!fs.existsSync(alertsPath)) {
  fail(`Missing alert config: ${alertsPath}`);
}

const dashboard = JSON.parse(fs.readFileSync(dashboardPath, "utf8"));
const widgets = Array.isArray(dashboard.widgets) ? dashboard.widgets : [];
const metrics = new Set(
  widgets.flatMap((widget) =>
    Array.isArray(widget.metrics) ? widget.metrics.filter((metric) => typeof metric === "string") : [],
  ),
);

const missingDashboardMetrics = requiredDashboardMetrics.filter((metric) => !metrics.has(metric));
if (missingDashboardMetrics.length > 0) {
  fail(`Dashboard is missing required metrics:\n- ${missingDashboardMetrics.join("\n- ")}`);
}

const alertsRaw = fs.readFileSync(alertsPath, "utf8");
const missingAlertNames = requiredAlertNames.filter((name) => !new RegExp(`\\bname:\\s*${name}\\b`).test(alertsRaw));
if (missingAlertNames.length > 0) {
  fail(`Alert config is missing required rules:\n- ${missingAlertNames.join("\n- ")}`);
}

console.log("Observability validation passed.");
console.log(`Dashboard metrics checked: ${requiredDashboardMetrics.length}`);
console.log(`Alert rules checked: ${requiredAlertNames.length}`);
