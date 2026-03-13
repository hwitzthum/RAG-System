#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { countEffectiveDocumentsByStatus } from "@/lib/ingestion/runtime/effective-documents";
import { collectMeasuredProcessingDurations, computeP95 } from "@/lib/ingestion/runtime/soak-metrics";

type RunMode = "live" | "dry-run";

type ScriptArgs = {
  mode: RunMode;
  windowHours: number;
  minCompletedJobs: number;
  minReadyDocuments: number;
  lockTimeoutSeconds: number;
  maxP95CompletionMs: number;
  maxDeadLetterGrowth: number;
  maxDuplicateWriteErrors: number;
  writeLatest: boolean;
  noFailOnGate: boolean;
};

type SoakCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

type SoakReport = {
  generatedAt: string;
  mode: RunMode;
  passed: boolean;
  thresholds: {
    windowHours: number;
    minCompletedJobs: number;
    minReadyDocuments: number;
    lockTimeoutSeconds: number;
    maxP95CompletionMs: number;
    maxDeadLetterGrowth: number;
    maxDuplicateWriteErrors: number;
  };
  observed: {
    completedJobsInWindow: number;
    readyDocumentsInWindow: number;
    stuckProcessingJobsBeyondLock: number;
    deadLetterCurrentWindow: number;
    deadLetterPreviousWindow: number;
    deadLetterGrowth: number;
    p95CompletionMs: number | null;
    duplicateWriteErrorCount: number;
  };
  checks: SoakCheck[];
};

type ProcessingJobRow = {
  id: string;
  locked_at: string | null;
  updated_at: string;
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
    windowHours: 24,
    minCompletedJobs: 25,
    minReadyDocuments: 25,
    lockTimeoutSeconds: parsePositiveInt(process.env.INGESTION_LOCK_TIMEOUT_SECONDS, 900),
    maxP95CompletionMs: 900_000,
    maxDeadLetterGrowth: 0,
    maxDuplicateWriteErrors: 0,
    writeLatest: true,
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
    } else if (token === "--window-hours") {
      args.windowHours = parsePositiveInt(argv[index + 1], args.windowHours);
      index += 1;
    } else if (token === "--min-completed-jobs") {
      args.minCompletedJobs = parsePositiveInt(argv[index + 1], args.minCompletedJobs);
      index += 1;
    } else if (token === "--min-ready-documents") {
      args.minReadyDocuments = parsePositiveInt(argv[index + 1], args.minReadyDocuments);
      index += 1;
    } else if (token === "--lock-timeout-seconds") {
      args.lockTimeoutSeconds = parsePositiveInt(argv[index + 1], args.lockTimeoutSeconds);
      index += 1;
    } else if (token === "--max-p95-completion-ms") {
      args.maxP95CompletionMs = parsePositiveInt(argv[index + 1], args.maxP95CompletionMs);
      index += 1;
    } else if (token === "--max-dead-letter-growth") {
      args.maxDeadLetterGrowth = Math.max(0, Number.parseInt(argv[index + 1] ?? "0", 10) || 0);
      index += 1;
    } else if (token === "--max-duplicate-write-errors") {
      args.maxDuplicateWriteErrors = Math.max(0, Number.parseInt(argv[index + 1] ?? "0", 10) || 0);
      index += 1;
    } else if (token === "--write-latest") {
      args.writeLatest = true;
    } else if (token === "--no-write-latest") {
      args.writeLatest = false;
    } else if (token === "--no-fail-on-gate") {
      args.noFailOnGate = true;
    }
  }

  if (!argv.includes("--write-latest") && !argv.includes("--no-write-latest") && args.mode === "dry-run") {
    args.writeLatest = false;
  }

  return args;
}

function writeReport(report: SoakReport, writeLatest: boolean): string {
  const outputDir = path.resolve("evaluation/performance");
  fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = report.generatedAt.replace(/[:.]/g, "-");
  const outputPath = path.join(outputDir, `staging-soak-${timestamp}.json`);
  const latestPath = path.join(outputDir, "staging-soak-latest.json");

  const payload = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(outputPath, payload, "utf8");
  if (writeLatest) {
    fs.writeFileSync(latestPath, payload, "utf8");
  }
  return outputPath;
}

function buildDryRunReport(args: ScriptArgs): SoakReport {
  const checks: SoakCheck[] = [
    {
      name: "completed_jobs_minimum_reached",
      passed: true,
      detail: "Synthetic check passed in dry-run mode.",
    },
    {
      name: "ready_documents_minimum_reached",
      passed: true,
      detail: "Synthetic check passed in dry-run mode.",
    },
    {
      name: "no_stuck_processing_jobs_beyond_lock_timeout",
      passed: true,
      detail: "Synthetic check passed in dry-run mode.",
    },
    {
      name: "dead_letter_growth_within_limit",
      passed: true,
      detail: "Synthetic check passed in dry-run mode.",
    },
    {
      name: "p95_completion_within_limit",
      passed: true,
      detail: "Synthetic check passed in dry-run mode.",
    },
    {
      name: "duplicate_write_errors_within_limit",
      passed: true,
      detail: "Synthetic check passed in dry-run mode.",
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    mode: "dry-run",
    passed: true,
    thresholds: {
      windowHours: args.windowHours,
      minCompletedJobs: args.minCompletedJobs,
      minReadyDocuments: args.minReadyDocuments,
      lockTimeoutSeconds: args.lockTimeoutSeconds,
      maxP95CompletionMs: args.maxP95CompletionMs,
      maxDeadLetterGrowth: args.maxDeadLetterGrowth,
      maxDuplicateWriteErrors: args.maxDuplicateWriteErrors,
    },
    observed: {
      completedJobsInWindow: args.minCompletedJobs,
      readyDocumentsInWindow: args.minReadyDocuments,
      stuckProcessingJobsBeyondLock: 0,
      deadLetterCurrentWindow: 0,
      deadLetterPreviousWindow: 0,
      deadLetterGrowth: 0,
      p95CompletionMs: Math.floor(args.maxP95CompletionMs * 0.5),
      duplicateWriteErrorCount: 0,
    },
    checks,
  };
}

async function buildLiveReport(args: ScriptArgs): Promise<SoakReport> {
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
  const cutoffIso = new Date(now - args.windowHours * 60 * 60 * 1000).toISOString();
  const previousCutoffIso = new Date(now - args.windowHours * 2 * 60 * 60 * 1000).toISOString();
  const staleCutoffMs = now - args.lockTimeoutSeconds * 1000;

  const { count: completedJobsRaw, error: completedJobsError } = await supabase
    .from("ingestion_jobs")
    .select("id", { head: true, count: "exact" })
    .eq("status", "completed")
    .gte("updated_at", cutoffIso);
  if (completedJobsError) {
    throw new Error(completedJobsError.message);
  }
  const completedJobsInWindow = completedJobsRaw ?? 0;

  const { data: completedRows, error: completedRowsError } = await supabase
    .from("ingestion_jobs")
    .select("processing_duration_ms")
    .eq("status", "completed")
    .gte("updated_at", cutoffIso)
    .limit(5000);
  if (completedRowsError) {
    throw new Error(completedRowsError.message);
  }

  const completionDurationsMs = collectMeasuredProcessingDurations(
    (completedRows ?? []) as Array<{ processing_duration_ms: number | null }>,
  );
  const p95CompletionMs = computeP95(completionDurationsMs);

  const readyDocumentsInWindow = await countEffectiveDocumentsByStatus(supabase, {
    status: "ready",
    updatedSince: cutoffIso,
  });

  const { data: processingRows, error: processingError } = await supabase
    .from("ingestion_jobs")
    .select("id, locked_at, updated_at")
    .eq("status", "processing")
    .limit(5000);
  if (processingError) {
    throw new Error(processingError.message);
  }

  const stuckProcessingJobsBeyondLock = (processingRows ?? []).filter((row: ProcessingJobRow) => {
    if (!row.locked_at) {
      return true;
    }
    const lockedAtMs = Date.parse(row.locked_at);
    return Number.isFinite(lockedAtMs) && lockedAtMs <= staleCutoffMs;
  }).length;

  const { count: deadLetterCurrentRaw, error: deadLetterCurrentError } = await supabase
    .from("ingestion_jobs")
    .select("id", { head: true, count: "exact" })
    .eq("status", "dead_letter")
    .gte("updated_at", cutoffIso);
  if (deadLetterCurrentError) {
    throw new Error(deadLetterCurrentError.message);
  }
  const deadLetterCurrentWindow = deadLetterCurrentRaw ?? 0;

  const { count: deadLetterPreviousRaw, error: deadLetterPreviousError } = await supabase
    .from("ingestion_jobs")
    .select("id", { head: true, count: "exact" })
    .eq("status", "dead_letter")
    .gte("updated_at", previousCutoffIso)
    .lt("updated_at", cutoffIso);
  if (deadLetterPreviousError) {
    throw new Error(deadLetterPreviousError.message);
  }
  const deadLetterPreviousWindow = deadLetterPreviousRaw ?? 0;
  const deadLetterGrowth = deadLetterCurrentWindow - deadLetterPreviousWindow;

  const { data: erroredRows, error: erroredRowsError } = await supabase
    .from("ingestion_jobs")
    .select("last_error")
    .not("last_error", "is", null)
    .gte("updated_at", cutoffIso)
    .limit(5000);
  if (erroredRowsError) {
    throw new Error(erroredRowsError.message);
  }

  const duplicateWriteErrorPattern = /(duplicate key value violates unique constraint|document_chunks_document_id_chunk_index_key)/i;
  const duplicateWriteErrorCount = (erroredRows ?? []).filter((row) => {
    const lastError = typeof row.last_error === "string" ? row.last_error : "";
    return duplicateWriteErrorPattern.test(lastError);
  }).length;

  const checks: SoakCheck[] = [
    {
      name: "completed_jobs_minimum_reached",
      passed: completedJobsInWindow >= args.minCompletedJobs,
      detail: `completed_jobs=${completedJobsInWindow}, min_required=${args.minCompletedJobs}, window_hours=${args.windowHours}`,
    },
    {
      name: "ready_documents_minimum_reached",
      passed: readyDocumentsInWindow >= args.minReadyDocuments,
      detail: `ready_documents=${readyDocumentsInWindow}, min_required=${args.minReadyDocuments}, window_hours=${args.windowHours}`,
    },
    {
      name: "no_stuck_processing_jobs_beyond_lock_timeout",
      passed: stuckProcessingJobsBeyondLock === 0,
      detail: `stuck_processing=${stuckProcessingJobsBeyondLock}, lock_timeout_seconds=${args.lockTimeoutSeconds}`,
    },
    {
      name: "dead_letter_growth_within_limit",
      passed: deadLetterGrowth <= args.maxDeadLetterGrowth,
      detail: `dead_letter_current=${deadLetterCurrentWindow}, dead_letter_previous=${deadLetterPreviousWindow}, growth=${deadLetterGrowth}, max_growth=${args.maxDeadLetterGrowth}`,
    },
    {
      name: "p95_completion_within_limit",
      passed: p95CompletionMs !== null && p95CompletionMs <= args.maxP95CompletionMs,
      detail:
        p95CompletionMs === null
          ? "No completed jobs with measured processing duration found in window; p95 completion cannot be evaluated."
          : `p95_completion_ms=${p95CompletionMs}, max_allowed_ms=${args.maxP95CompletionMs}`,
    },
    {
      name: "duplicate_write_errors_within_limit",
      passed: duplicateWriteErrorCount <= args.maxDuplicateWriteErrors,
      detail: `duplicate_write_errors=${duplicateWriteErrorCount}, max_allowed=${args.maxDuplicateWriteErrors}`,
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    mode: "live",
    passed: checks.every((check) => check.passed),
    thresholds: {
      windowHours: args.windowHours,
      minCompletedJobs: args.minCompletedJobs,
      minReadyDocuments: args.minReadyDocuments,
      lockTimeoutSeconds: args.lockTimeoutSeconds,
      maxP95CompletionMs: args.maxP95CompletionMs,
      maxDeadLetterGrowth: args.maxDeadLetterGrowth,
      maxDuplicateWriteErrors: args.maxDuplicateWriteErrors,
    },
    observed: {
      completedJobsInWindow,
      readyDocumentsInWindow,
      stuckProcessingJobsBeyondLock,
      deadLetterCurrentWindow,
      deadLetterPreviousWindow,
      deadLetterGrowth,
      p95CompletionMs,
      duplicateWriteErrorCount,
    },
    checks,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const report = args.mode === "dry-run" ? buildDryRunReport(args) : await buildLiveReport(args);
  const artifact = writeReport(report, args.writeLatest);

  console.log(`Staging soak verification completed (mode=${report.mode}).`);
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
  console.error(`Staging soak verification failed: ${message}`);
  process.exit(1);
});
