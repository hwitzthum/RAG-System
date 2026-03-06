#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";

type BenchmarkGateMode = "live" | "allow-dry";

type ScriptArgs = {
  benchmarkGateMode: BenchmarkGateMode;
};

type GateResult = {
  gate: string;
  passed: boolean;
  detail: string;
};

type ReadinessReport = {
  generatedAt: string;
  passed: boolean;
  gates: GateResult[];
  references: {
    benchmarkRun: string | null;
    benchmarkReport: string | null;
    loadTest: string | null;
    resilience: string | null;
    ingestionHealth: string | null;
    stagingSoak: string | null;
  };
};

function parseArgs(argv: string[]): ScriptArgs {
  const args: ScriptArgs = {
    benchmarkGateMode: "live",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--benchmark-gate-mode") {
      const mode = argv[index + 1];
      if (mode === "live" || mode === "allow-dry") {
        args.benchmarkGateMode = mode;
      }
      index += 1;
    }
  }

  return args;
}

function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function hasFile(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function gate(gateName: string, passed: boolean, detail: string): GateResult {
  return { gate: gateName, passed, detail };
}

function buildMarkdown(report: ReadinessReport): string {
  const gateRows = report.gates
    .map((item) => `| ${item.gate} | ${item.passed ? "PASS" : "FAIL"} | ${item.detail} |`)
    .join("\n");

  return `# Release Readiness Report

Generated: ${report.generatedAt}
Overall status: ${report.passed ? "PASS" : "FAIL"}

## Gate Summary

| Gate | Status | Detail |
| --- | --- | --- |
${gateRows}

## Artifact References

- benchmark run: ${report.references.benchmarkRun ?? "missing"}
- benchmark report: ${report.references.benchmarkReport ?? "missing"}
- load test: ${report.references.loadTest ?? "missing"}
- resilience checks: ${report.references.resilience ?? "missing"}
- ingestion cron/backlog health: ${report.references.ingestionHealth ?? "missing"}
- staging soak verification: ${report.references.stagingSoak ?? "missing"}
`;
}

function writeReport(report: ReadinessReport): string {
  const outputDir = path.resolve("evaluation/reports");
  fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = report.generatedAt.replace(/[:.]/g, "-");
  const outputPath = path.join(outputDir, `release-readiness-${timestamp}.md`);
  const latestPath = path.join(outputDir, "release-readiness-latest.md");

  const markdown = buildMarkdown(report);
  fs.writeFileSync(outputPath, markdown, "utf8");
  fs.writeFileSync(latestPath, markdown, "utf8");
  return outputPath;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const benchmarkRunPath = path.resolve("evaluation/runs/latest.json");
  const benchmarkReportPath = path.resolve("evaluation/reports/latest.md");
  const loadTestPath = path.resolve("evaluation/performance/load-test-latest.json");
  const resiliencePath = path.resolve("evaluation/performance/resilience-latest.json");
  const ingestionHealthPath = path.resolve("evaluation/performance/ingestion-health-latest.json");
  const stagingSoakPath = path.resolve("evaluation/performance/staging-soak-latest.json");
  const dashboardPath = path.resolve("observability/dashboards/rag-system-overview.json");
  const alertsPath = path.resolve("observability/alerts/rag-system-alerts.yaml");

  const benchmark = readJsonIfExists<{
    mode: string;
    thresholdEvaluation?: { passed?: boolean };
    summary?: { overall?: { systemErrorCount?: number } };
  }>(benchmarkRunPath);

  const loadTest = readJsonIfExists<{
    mode: string;
    p95LatencyMs: number;
    errorRate: number;
    totalRequests: number;
  }>(loadTestPath);

  const resilience = readJsonIfExists<{
    mode: string;
    passed: boolean;
    checks: Array<{ name: string; passed: boolean }>;
  }>(resiliencePath);

  const ingestionHealth = readJsonIfExists<{
    mode: string;
    passed: boolean;
    observed?: { queuedCount?: number; staleProcessingCount?: number; recentProgressCount?: number };
  }>(ingestionHealthPath);

  const stagingSoak = readJsonIfExists<{
    mode: string;
    passed: boolean;
    observed?: {
      completedJobsInWindow?: number;
      readyDocumentsInWindow?: number;
      stuckProcessingJobsBeyondLock?: number;
      deadLetterGrowth?: number;
      p95CompletionMs?: number | null;
      duplicateWriteErrorCount?: number;
    };
  }>(stagingSoakPath);

  const gates: GateResult[] = [];
  const benchmarkGateName = args.benchmarkGateMode === "live" ? "benchmark_live_gate" : "benchmark_threshold_gate";
  const benchmarkPasses =
    benchmark &&
    benchmark.thresholdEvaluation?.passed === true &&
    (args.benchmarkGateMode === "allow-dry" ? ["live", "dry-run"].includes(benchmark.mode) : benchmark.mode === "live");
  gates.push(
    gate(
      benchmarkGateName,
      Boolean(benchmarkPasses),
      benchmark
        ? `mode=${benchmark.mode}, required_mode=${args.benchmarkGateMode}, gate=${benchmark.thresholdEvaluation?.passed === true}, systemErrors=${benchmark.summary?.overall?.systemErrorCount ?? "n/a"}`
        : "Missing evaluation/runs/latest.json",
    ),
  );

  gates.push(
    gate(
      "observability_config_present",
      hasFile(dashboardPath) && hasFile(alertsPath),
      hasFile(dashboardPath) && hasFile(alertsPath)
        ? "Dashboard and alert configs present."
        : "Missing dashboard or alert config file.",
    ),
  );

  gates.push(
    gate(
      "load_test_gate",
      Boolean(loadTest && loadTest.totalRequests > 0 && loadTest.p95LatencyMs < 7000 && loadTest.errorRate < 0.02),
      loadTest
        ? `mode=${loadTest.mode}, p95=${loadTest.p95LatencyMs}ms, errorRate=${loadTest.errorRate.toFixed(4)}, requests=${loadTest.totalRequests}`
        : "Missing evaluation/performance/load-test-latest.json",
    ),
  );

  gates.push(
    gate(
      "resilience_gate",
      Boolean(resilience && resilience.passed),
      resilience
        ? `mode=${resilience.mode}, checks=${resilience.checks.filter((check) => check.passed).length}/${resilience.checks.length}`
        : "Missing evaluation/performance/resilience-latest.json",
    ),
  );

  gates.push(
    gate(
      "ingestion_health_gate",
      Boolean(ingestionHealth && ingestionHealth.mode === "live" && ingestionHealth.passed),
      ingestionHealth
        ? `mode=${ingestionHealth.mode}, passed=${ingestionHealth.passed}, queued=${ingestionHealth.observed?.queuedCount ?? "n/a"}, stale=${ingestionHealth.observed?.staleProcessingCount ?? "n/a"}, recentProgress=${ingestionHealth.observed?.recentProgressCount ?? "n/a"}`
        : "Missing evaluation/performance/ingestion-health-latest.json",
      ),
  );

  gates.push(
    gate(
      "staging_soak_gate",
      Boolean(stagingSoak && stagingSoak.mode === "live" && stagingSoak.passed),
      stagingSoak
        ? `mode=${stagingSoak.mode}, passed=${stagingSoak.passed}, completedJobs=${stagingSoak.observed?.completedJobsInWindow ?? "n/a"}, readyDocuments=${stagingSoak.observed?.readyDocumentsInWindow ?? "n/a"}, stuckProcessing=${stagingSoak.observed?.stuckProcessingJobsBeyondLock ?? "n/a"}, deadLetterGrowth=${stagingSoak.observed?.deadLetterGrowth ?? "n/a"}, p95CompletionMs=${stagingSoak.observed?.p95CompletionMs ?? "n/a"}, duplicateWriteErrors=${stagingSoak.observed?.duplicateWriteErrorCount ?? "n/a"}`
        : "Missing evaluation/performance/staging-soak-latest.json",
    ),
  );

  const report: ReadinessReport = {
    generatedAt: new Date().toISOString(),
    passed: gates.every((entry) => entry.passed),
    gates,
    references: {
      benchmarkRun: hasFile(benchmarkRunPath) ? benchmarkRunPath : null,
      benchmarkReport: hasFile(benchmarkReportPath) ? benchmarkReportPath : null,
      loadTest: hasFile(loadTestPath) ? loadTestPath : null,
      resilience: hasFile(resiliencePath) ? resiliencePath : null,
      ingestionHealth: hasFile(ingestionHealthPath) ? ingestionHealthPath : null,
      stagingSoak: hasFile(stagingSoakPath) ? stagingSoakPath : null,
    },
  };

  const outputPath = writeReport(report);
  console.log(`Release readiness report: ${outputPath}`);
  console.log(`Overall status: ${report.passed ? "PASS" : "FAIL"}`);

  if (!report.passed) {
    process.exit(2);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Release readiness generation failed: ${message}`);
  process.exit(1);
});
