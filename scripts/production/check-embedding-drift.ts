#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  computeEmbeddingSnapshot,
  DEFAULT_EMBEDDING_DRIFT_THRESHOLDS,
  evaluateEmbeddingDrift,
  type EmbeddingDriftThresholds,
  type EmbeddingSample,
  type EmbeddingSnapshot,
} from "@/lib/retrieval/embedding-drift";

type RunMode = "live" | "dry-run";

type ScriptArgs = {
  mode: RunMode;
  sampleSize: number;
  noFailOnGate: boolean;
  refreshBaseline: boolean;
};

type EmbeddingDriftReport = {
  generatedAt: string;
  mode: RunMode;
  passed: boolean;
  baselineUpdated: boolean;
  thresholds: EmbeddingDriftThresholds;
  current: EmbeddingSnapshot;
  baseline: EmbeddingSnapshot | null;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
};

const BASELINE_FILE = "embedding-drift-baseline.json";
const LATEST_FILE = "embedding-drift-latest.json";

function normalizeEmbedding(value: number[] | string): number[] {
  if (Array.isArray(value)) {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error("Embedding value is not a recognized vector payload");
  }

  return trimmed
    .slice(1, -1)
    .split(",")
    .map((part) => Number.parseFloat(part))
    .filter((part) => Number.isFinite(part));
}

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
    sampleSize: 1000,
    noFailOnGate: false,
    refreshBaseline: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--mode") {
      const mode = argv[index + 1];
      if (mode === "live" || mode === "dry-run") {
        args.mode = mode;
      }
      index += 1;
    } else if (token === "--sample-size") {
      args.sampleSize = parsePositiveInt(argv[index + 1], args.sampleSize);
      index += 1;
    } else if (token === "--refresh-baseline") {
      args.refreshBaseline = true;
    } else if (token === "--no-fail-on-gate") {
      args.noFailOnGate = true;
    }
  }

  return args;
}

function reportDir(): string {
  return path.resolve("evaluation/performance");
}

function baselinePath(): string {
  return path.join(reportDir(), BASELINE_FILE);
}

function latestPath(): string {
  return path.join(reportDir(), LATEST_FILE);
}

function loadBaseline(): EmbeddingSnapshot | null {
  const targetPath = baselinePath();
  if (!fs.existsSync(targetPath)) {
    return null;
  }

  const payload = JSON.parse(fs.readFileSync(targetPath, "utf8")) as { snapshot?: EmbeddingSnapshot };
  return payload.snapshot ?? null;
}

function writeArtifacts(report: EmbeddingDriftReport): string {
  const outputDir = reportDir();
  fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = report.generatedAt.replace(/[:.]/g, "-");
  const outputPath = path.join(outputDir, `embedding-drift-${timestamp}.json`);
  const payload = `${JSON.stringify(report, null, 2)}\n`;

  fs.writeFileSync(outputPath, payload, "utf8");
  fs.writeFileSync(latestPath(), payload, "utf8");

  if (report.baselineUpdated) {
    fs.writeFileSync(
      baselinePath(),
      `${JSON.stringify({ updatedAt: report.generatedAt, snapshot: report.current }, null, 2)}\n`,
      "utf8",
    );
  }

  return outputPath;
}

function buildDryRunReport(): EmbeddingDriftReport {
  const baseline = computeEmbeddingSnapshot([
    { embedding: [1, 0, 0], language: "EN" },
    { embedding: [0.9, 0.1, 0], language: "EN" },
    { embedding: [0, 1, 0], language: "DE" },
  ]);
  const current = computeEmbeddingSnapshot([
    { embedding: [0.98, 0.02, 0], language: "EN" },
    { embedding: [0.88, 0.12, 0], language: "EN" },
    { embedding: [0.05, 0.95, 0], language: "DE" },
  ]);
  const evaluation = evaluateEmbeddingDrift({
    current,
    baseline,
    thresholds: {
      minSamples: 3,
      minLanguageSamples: 1,
    },
  });

  return {
    generatedAt: new Date().toISOString(),
    mode: "dry-run",
    passed: evaluation.passed,
    baselineUpdated: false,
    thresholds: {
      ...DEFAULT_EMBEDDING_DRIFT_THRESHOLDS,
      minSamples: 3,
      minLanguageSamples: 1,
    },
    current,
    baseline,
    checks: evaluation.checks,
  };
}

async function loadLiveSamples(sampleSize: number): Promise<EmbeddingSample[]> {
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

  const { data, error } = await supabase
    .from("document_chunks")
    .select("embedding,language,created_at")
    .order("created_at", { ascending: false })
    .limit(sampleSize);

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as Array<{ embedding: number[] | string; language: EmbeddingSample["language"] }>).map((row) => ({
    embedding: normalizeEmbedding(row.embedding),
    language: row.language,
  }));
}

async function buildLiveReport(args: ScriptArgs): Promise<EmbeddingDriftReport> {
  const current = computeEmbeddingSnapshot(await loadLiveSamples(args.sampleSize));
  const baseline = args.refreshBaseline ? null : loadBaseline();
  const evaluation = evaluateEmbeddingDrift({
    current,
    baseline,
  });
  const baselineUpdated = args.refreshBaseline || !baseline;

  return {
    generatedAt: new Date().toISOString(),
    mode: "live",
    passed: evaluation.passed,
    baselineUpdated,
    thresholds: DEFAULT_EMBEDDING_DRIFT_THRESHOLDS,
    current,
    baseline,
    checks: evaluation.checks,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const report = args.mode === "dry-run" ? buildDryRunReport() : await buildLiveReport(args);
  const outputPath = writeArtifacts(report);
  process.stdout.write(`${JSON.stringify({ outputPath, passed: report.passed, baselineUpdated: report.baselineUpdated }, null, 2)}\n`);
  if (!report.passed && !args.noFailOnGate) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
