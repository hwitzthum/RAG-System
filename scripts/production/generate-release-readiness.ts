#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";

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
  };
};

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
  const benchmarkRunPath = path.resolve("evaluation/runs/latest.json");
  const benchmarkReportPath = path.resolve("evaluation/reports/latest.md");
  const loadTestPath = path.resolve("evaluation/performance/load-test-latest.json");
  const resiliencePath = path.resolve("evaluation/performance/resilience-latest.json");
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

  const gates: GateResult[] = [];
  gates.push(
    gate(
      "benchmark_live_gate",
      Boolean(benchmark && benchmark.mode === "live" && benchmark.thresholdEvaluation?.passed === true),
      benchmark
        ? `mode=${benchmark.mode}, gate=${benchmark.thresholdEvaluation?.passed === true}, systemErrors=${benchmark.summary?.overall?.systemErrorCount ?? "n/a"}`
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

  const report: ReadinessReport = {
    generatedAt: new Date().toISOString(),
    passed: gates.every((entry) => entry.passed),
    gates,
    references: {
      benchmarkRun: hasFile(benchmarkRunPath) ? benchmarkRunPath : null,
      benchmarkReport: hasFile(benchmarkReportPath) ? benchmarkReportPath : null,
      loadTest: hasFile(loadTestPath) ? loadTestPath : null,
      resilience: hasFile(resiliencePath) ? resiliencePath : null,
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

