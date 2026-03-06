#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";

type RunMode = "live" | "dry-run";

type LoadTestArgs = {
  baseUrl: string;
  token: string;
  query: string;
  languageHint: "EN" | "DE" | "FR" | "IT" | "ES";
  durationSeconds: number;
  concurrency: number;
  mode: RunMode;
};

type LoadTestResult = {
  generatedAt: string;
  mode: RunMode;
  baseUrl: string;
  durationSeconds: number;
  concurrency: number;
  totalRequests: number;
  successResponses: number;
  nonSuccessResponses: number;
  errorCount: number;
  errorRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  notes: string[];
};

function parseArgs(argv: string[]): LoadTestArgs {
  const args: LoadTestArgs = {
    baseUrl: "",
    token: "",
    query: "Summarize the key due diligence risks for this company.",
    languageHint: "EN",
    durationSeconds: 60,
    concurrency: 10,
    mode: "live",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--base-url") {
      args.baseUrl = argv[index + 1] ?? args.baseUrl;
      index += 1;
    } else if (token === "--token") {
      args.token = argv[index + 1] ?? args.token;
      index += 1;
    } else if (token === "--query") {
      args.query = argv[index + 1] ?? args.query;
      index += 1;
    } else if (token === "--language") {
      const language = (argv[index + 1] ?? args.languageHint).toUpperCase();
      if (["EN", "DE", "FR", "IT", "ES"].includes(language)) {
        args.languageHint = language as LoadTestArgs["languageHint"];
      }
      index += 1;
    } else if (token === "--duration-seconds") {
      const parsed = Number.parseInt(argv[index + 1] ?? `${args.durationSeconds}`, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        args.durationSeconds = parsed;
      }
      index += 1;
    } else if (token === "--concurrency") {
      const parsed = Number.parseInt(argv[index + 1] ?? `${args.concurrency}`, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        args.concurrency = parsed;
      }
      index += 1;
    } else if (token === "--mode") {
      const mode = argv[index + 1] ?? args.mode;
      if (mode === "live" || mode === "dry-run") {
        args.mode = mode;
      }
      index += 1;
    }
  }

  return args;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function writeResult(result: LoadTestResult): string {
  const timestamp = result.generatedAt.replace(/[:.]/g, "-");
  const outputDir = path.resolve("evaluation/performance");
  fs.mkdirSync(outputDir, { recursive: true });

  const filename = `load-test-${timestamp}.json`;
  const outputPath = path.join(outputDir, filename);
  const latestPath = path.join(outputDir, "load-test-latest.json");

  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  fs.writeFileSync(latestPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return outputPath;
}

async function runDry(args: LoadTestArgs): Promise<LoadTestResult> {
  const generatedAt = new Date().toISOString();
  const totalRequests = args.durationSeconds * args.concurrency * 2;
  const successResponses = Math.floor(totalRequests * 0.995);
  const nonSuccessResponses = totalRequests - successResponses;

  return {
    generatedAt,
    mode: "dry-run",
    baseUrl: args.baseUrl || "dry-run",
    durationSeconds: args.durationSeconds,
    concurrency: args.concurrency,
    totalRequests,
    successResponses,
    nonSuccessResponses,
    errorCount: 0,
    errorRate: nonSuccessResponses / totalRequests,
    p50LatencyMs: 640,
    p95LatencyMs: 1880,
    notes: ["Synthetic load test result generated in dry-run mode."],
  };
}

async function runLive(args: LoadTestArgs): Promise<LoadTestResult> {
  if (!args.baseUrl) {
    throw new Error("Missing --base-url for live load test.");
  }
  if (!args.token) {
    throw new Error("Missing --token for live load test.");
  }

  const queryUrl = `${args.baseUrl.replace(/\/+$/, "")}/api/query`;
  const deadline = Date.now() + args.durationSeconds * 1000;

  const latencies: number[] = [];
  let totalRequests = 0;
  let successResponses = 0;
  let nonSuccessResponses = 0;
  let errorCount = 0;

  async function worker(): Promise<void> {
    while (Date.now() < deadline) {
      const start = Date.now();
      try {
        const response = await fetch(queryUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${args.token}`,
          },
          body: JSON.stringify({
            query: args.query,
            languageHint: args.languageHint,
            topK: 8,
          }),
        });

        await response.text();
        const latency = Date.now() - start;
        latencies.push(latency);
        totalRequests += 1;

        if (response.ok) {
          successResponses += 1;
        } else {
          nonSuccessResponses += 1;
        }
      } catch {
        const latency = Date.now() - start;
        latencies.push(latency);
        totalRequests += 1;
        errorCount += 1;
        nonSuccessResponses += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: args.concurrency }, async () => worker()));

  const generatedAt = new Date().toISOString();
  const denom = Math.max(1, totalRequests);
  return {
    generatedAt,
    mode: "live",
    baseUrl: args.baseUrl,
    durationSeconds: args.durationSeconds,
    concurrency: args.concurrency,
    totalRequests,
    successResponses,
    nonSuccessResponses,
    errorCount,
    errorRate: nonSuccessResponses / denom,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    notes: [],
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const result = args.mode === "dry-run" ? await runDry(args) : await runLive(args);
  const outputPath = writeResult(result);

  console.log(`Load test completed (mode=${result.mode}).`);
  console.log(`Requests=${result.totalRequests}, success=${result.successResponses}, errors=${result.nonSuccessResponses}`);
  console.log(`p50=${result.p50LatencyMs}ms, p95=${result.p95LatencyMs}ms`);
  console.log(`Artifact: ${outputPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Load test failed: ${message}`);
  process.exit(1);
});

