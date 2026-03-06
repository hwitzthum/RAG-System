#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

type RunMode = "live" | "dry-run";

type ScriptArgs = {
  mode: RunMode;
  queueThreshold: number;
  staleProcessingMinutes: number;
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
    noProgressMinutes: number;
  };
  observed: {
    queuedCount: number;
    staleProcessingCount: number;
    recentProgressCount: number;
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
      noProgressMinutes: args.noProgressMinutes,
    },
    observed: {
      queuedCount: 0,
      staleProcessingCount: 0,
      recentProgressCount: 1,
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
  const staleCutoffIso = new Date(now - args.staleProcessingMinutes * 60_000).toISOString();
  const progressCutoffIso = new Date(now - args.noProgressMinutes * 60_000).toISOString();

  const { count: queuedCountRaw, error: queuedError } = await supabase
    .from("ingestion_jobs")
    .select("id", { head: true, count: "exact" })
    .eq("status", "queued");
  if (queuedError) {
    throw new Error(queuedError.message);
  }
  const queuedCount = queuedCountRaw ?? 0;

  const { count: staleCountRaw, error: staleError } = await supabase
    .from("ingestion_jobs")
    .select("id", { head: true, count: "exact" })
    .eq("status", "processing")
    .lte("locked_at", staleCutoffIso);
  if (staleError) {
    throw new Error(staleError.message);
  }
  const staleProcessingCount = staleCountRaw ?? 0;

  const { count: recentProgressRaw, error: recentProgressError } = await supabase
    .from("ingestion_jobs")
    .select("id", { head: true, count: "exact" })
    .in("status", ["processing", "completed", "failed", "dead_letter"])
    .gte("updated_at", progressCutoffIso);
  if (recentProgressError) {
    throw new Error(recentProgressError.message);
  }
  const recentProgressCount = recentProgressRaw ?? 0;

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
      name: "cron_progress_present_when_queue_exists",
      passed: queuedCount === 0 || recentProgressCount > 0,
      detail:
        queuedCount === 0
          ? "No queued jobs; cron progress requirement not applicable."
          : `queued=${queuedCount}, recent_progress=${recentProgressCount}, no_progress_minutes=${args.noProgressMinutes}`,
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    mode: "live",
    passed: checks.every((check) => check.passed),
    thresholds: {
      queueThreshold: args.queueThreshold,
      staleProcessingMinutes: args.staleProcessingMinutes,
      noProgressMinutes: args.noProgressMinutes,
    },
    observed: {
      queuedCount,
      staleProcessingCount,
      recentProgressCount,
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
