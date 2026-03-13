#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  countProcessingDocumentMismatches,
  countReadyDocumentsWithoutChunks,
  summarizeProcessingHeartbeat,
} from "@/lib/ingestion/runtime/health-view";

type RunMode = "live" | "dry-run";

type ScriptArgs = {
  mode: RunMode;
  queueThreshold: number;
  staleProcessingMinutes: number;
  heartbeatLagMinutes: number;
  noProgressMinutes: number;
  noFailOnGate: boolean;
};

type IngestionHealthCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

type IngestionHealthReport = {
  generatedAt: string;
  mode: RunMode;
  passed: boolean;
  thresholds: {
    queueThreshold: number;
    staleProcessingMinutes: number;
    heartbeatLagMinutes: number;
    noProgressMinutes: number;
  };
  observed: {
    queuedCount: number;
    staleProcessingCount: number;
    laggingProcessingCount: number;
    maxHeartbeatLagSeconds: number | null;
    processingStageCounts: Record<string, number>;
    recentProgressCount: number;
    inconsistentDocumentCount: number;
    readyWithoutChunksCount: number;
    processingWithoutLockCount: number;
    nonProcessingWithLockCount: number;
  };
  checks: IngestionHealthCheck[];
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv: string[]): ScriptArgs {
  const args: ScriptArgs = {
    mode: "live",
    queueThreshold: 25,
    staleProcessingMinutes: 20,
    heartbeatLagMinutes: 5,
    noProgressMinutes: 15,
    noFailOnGate: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--mode") {
      const mode = argv[index + 1];
      if (mode === "live" || mode === "dry-run") {
        args.mode = mode;
      }
      index += 1;
    } else if (token === "--queue-threshold") {
      args.queueThreshold = parsePositiveInt(argv[index + 1], args.queueThreshold);
      index += 1;
    } else if (token === "--stale-processing-minutes") {
      args.staleProcessingMinutes = parsePositiveInt(argv[index + 1], args.staleProcessingMinutes);
      index += 1;
    } else if (token === "--heartbeat-lag-minutes") {
      args.heartbeatLagMinutes = parsePositiveInt(argv[index + 1], args.heartbeatLagMinutes);
      index += 1;
    } else if (token === "--no-progress-minutes") {
      args.noProgressMinutes = parsePositiveInt(argv[index + 1], args.noProgressMinutes);
      index += 1;
    } else if (token === "--no-fail-on-gate") {
      args.noFailOnGate = true;
    }
  }

  return args;
}

function writeReport(report: IngestionHealthReport): string {
  const outputDir = path.resolve("evaluation/performance");
  fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = report.generatedAt.replace(/[:.]/g, "-");
  const outputPath = path.join(outputDir, `ingestion-health-${timestamp}.json`);
  const latestPath = path.join(outputDir, "ingestion-health-latest.json");

  const payload = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(outputPath, payload, "utf8");
  fs.writeFileSync(latestPath, payload, "utf8");
  return outputPath;
}

function buildDryRunReport(args: ScriptArgs): IngestionHealthReport {
  const checks: IngestionHealthCheck[] = [
    {
      name: "queue_backlog_within_limit",
      passed: true,
      detail: "Synthetic check passed in dry-run mode.",
    },
    {
      name: "stale_processing_jobs_absent",
      passed: true,
      detail: "Synthetic check passed in dry-run mode.",
    },
    {
      name: "cron_progress_present_when_queue_exists",
      passed: true,
      detail: "Synthetic check passed in dry-run mode.",
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    mode: "dry-run",
    passed: true,
    thresholds: {
      queueThreshold: args.queueThreshold,
      staleProcessingMinutes: args.staleProcessingMinutes,
      heartbeatLagMinutes: args.heartbeatLagMinutes,
      noProgressMinutes: args.noProgressMinutes,
    },
    observed: {
      queuedCount: 0,
      staleProcessingCount: 0,
      laggingProcessingCount: 0,
      maxHeartbeatLagSeconds: 0,
      processingStageCounts: {},
      recentProgressCount: 1,
      inconsistentDocumentCount: 0,
      readyWithoutChunksCount: 0,
      processingWithoutLockCount: 0,
      nonProcessingWithLockCount: 0,
    },
    checks,
  };
}

async function buildLiveReport(args: ScriptArgs): Promise<IngestionHealthReport> {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for live mode.");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const now = Date.now();
  const progressCutoffIso = new Date(now - args.noProgressMinutes * 60_000).toISOString();

  const { count: queuedCountRaw, error: queuedError } = await supabase
    .from("ingestion_jobs")
    .select("id", { head: true, count: "exact" })
    .eq("status", "queued");
  if (queuedError) {
    throw new Error(queuedError.message);
  }
  const queuedCount = queuedCountRaw ?? 0;

  const { data: processingRows, error: processingError } = await supabase
    .from("ingestion_jobs")
    .select("locked_at,locked_by,updated_at,current_stage")
    .eq("status", "processing");
  if (processingError) {
    throw new Error(processingError.message);
  }
  const processingHeartbeatSummary = summarizeProcessingHeartbeat(
    (processingRows ?? []) as Array<{
      locked_at: string | null;
      locked_by: string | null;
      updated_at: string;
      current_stage: string | null;
    }>,
    {
      nowMs: now,
      staleProcessingMinutes: args.staleProcessingMinutes,
      heartbeatLagMinutes: args.heartbeatLagMinutes,
    },
  );
  const staleProcessingCount = processingHeartbeatSummary.staleProcessingCount;
  const laggingProcessingCount = processingHeartbeatSummary.laggingProcessingCount;
  const maxHeartbeatLagSeconds = processingHeartbeatSummary.maxHeartbeatLagSeconds;
  const processingStageCounts = processingHeartbeatSummary.stageCounts;

  const { count: recentProgressRaw, error: recentProgressError } = await supabase
    .from("ingestion_jobs")
    .select("id", { head: true, count: "exact" })
    .in("status", ["processing", "completed", "failed", "dead_letter"])
    .gte("updated_at", progressCutoffIso);
  if (recentProgressError) {
    throw new Error(recentProgressError.message);
  }
  const recentProgressCount = recentProgressRaw ?? 0;

  const { data: effectiveDocuments, error: effectiveDocumentsError } = await supabase
    .from("document_effective_statuses")
    .select("raw_document_status,latest_job_status,chunk_count")
    .in("raw_document_status", ["processing", "ready"]);
  if (effectiveDocumentsError) {
    throw new Error(effectiveDocumentsError.message);
  }

  const effectiveDocumentRows = (effectiveDocuments ?? []) as Array<{
    raw_document_status: "queued" | "processing" | "ready" | "failed";
    latest_job_status: "queued" | "processing" | "completed" | "failed" | "dead_letter" | null;
    chunk_count: number;
  }>;
  const inconsistentDocumentCount = countProcessingDocumentMismatches(effectiveDocumentRows);
  const readyWithoutChunksCount = countReadyDocumentsWithoutChunks(effectiveDocumentRows);

  const processingWithoutLockCount = processingHeartbeatSummary.processingWithoutLockCount;

  const { count: nonProcessingWithLockRaw, error: nonProcessingWithLockError } = await supabase
    .from("ingestion_jobs")
    .select("id", { head: true, count: "exact" })
    .in("status", ["queued", "failed", "dead_letter", "completed"])
    .not("locked_at", "is", null);
  if (nonProcessingWithLockError) {
    throw new Error(nonProcessingWithLockError.message);
  }
  const nonProcessingWithLockCount = nonProcessingWithLockRaw ?? 0;

  const checks: IngestionHealthCheck[] = [
    {
      name: "queue_backlog_within_limit",
      passed: queuedCount <= args.queueThreshold,
      detail: `queued=${queuedCount}, threshold=${args.queueThreshold}`,
    },
    {
      name: "stale_processing_jobs_absent",
      passed: staleProcessingCount === 0,
      detail: `stale_processing=${staleProcessingCount}, stale_window_minutes=${args.staleProcessingMinutes}`,
    },
    {
      name: "processing_jobs_heartbeating_recently",
      passed: laggingProcessingCount === 0,
      detail:
        maxHeartbeatLagSeconds === null
          ? `lagging_processing=${laggingProcessingCount}, heartbeat_lag_minutes=${args.heartbeatLagMinutes}, max_heartbeat_lag_seconds=null`
          : `lagging_processing=${laggingProcessingCount}, heartbeat_lag_minutes=${args.heartbeatLagMinutes}, max_heartbeat_lag_seconds=${maxHeartbeatLagSeconds}`,
    },
    {
      name: "cron_progress_present_when_queue_exists",
      passed: queuedCount === 0 || recentProgressCount > 0,
      detail:
        queuedCount === 0
          ? "No queued jobs; cron progress requirement not applicable."
          : `queued=${queuedCount}, recent_progress=${recentProgressCount}, no_progress_minutes=${args.noProgressMinutes}`,
    },
    {
      name: "processing_documents_match_active_jobs",
      passed: inconsistentDocumentCount === 0,
      detail: `inconsistent_documents=${inconsistentDocumentCount}`,
    },
    {
      name: "ready_documents_have_chunks",
      passed: readyWithoutChunksCount === 0,
      detail: `ready_without_chunks=${readyWithoutChunksCount}`,
    },
    {
      name: "processing_jobs_have_locks",
      passed: processingWithoutLockCount === 0,
      detail: `processing_without_lock=${processingWithoutLockCount}`,
    },
    {
      name: "non_processing_jobs_are_unlocked",
      passed: nonProcessingWithLockCount === 0,
      detail: `non_processing_with_lock=${nonProcessingWithLockCount}`,
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    mode: "live",
    passed: checks.every((check) => check.passed),
    thresholds: {
      queueThreshold: args.queueThreshold,
      staleProcessingMinutes: args.staleProcessingMinutes,
      heartbeatLagMinutes: args.heartbeatLagMinutes,
      noProgressMinutes: args.noProgressMinutes,
    },
    observed: {
      queuedCount,
      staleProcessingCount,
      laggingProcessingCount,
      maxHeartbeatLagSeconds,
      processingStageCounts,
      recentProgressCount,
      inconsistentDocumentCount,
      readyWithoutChunksCount,
      processingWithoutLockCount,
      nonProcessingWithLockCount,
    },
    checks,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const report = args.mode === "dry-run" ? buildDryRunReport(args) : await buildLiveReport(args);
  const artifact = writeReport(report);

  console.log(`Ingestion health checks completed (mode=${report.mode}).`);
  console.log(`Passed=${report.passed}`);
  for (const check of report.checks) {
    console.log(`- ${check.name}: ${check.passed ? "PASS" : "FAIL"} (${check.detail})`);
  }
  console.log(`Artifact: ${artifact}`);

  if (!report.passed && !args.noFailOnGate) {
    process.exit(2);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Ingestion health checks failed: ${message}`);
  process.exit(1);
});
