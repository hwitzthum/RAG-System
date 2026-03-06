#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";

type RunMode = "live" | "dry-run";

type ResilienceArgs = {
  baseUrl: string;
  token: string;
  mode: RunMode;
};

type CheckResult = {
  name: string;
  passed: boolean;
  statusCode: number | null;
  detail: string;
};

type ResilienceResult = {
  generatedAt: string;
  mode: RunMode;
  baseUrl: string;
  passed: boolean;
  checks: CheckResult[];
};

function parseArgs(argv: string[]): ResilienceArgs {
  const args: ResilienceArgs = {
    baseUrl: "",
    token: "",
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

function writeResult(result: ResilienceResult): string {
  const timestamp = result.generatedAt.replace(/[:.]/g, "-");
  const outputDir = path.resolve("evaluation/performance");
  fs.mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, `resilience-${timestamp}.json`);
  const latestPath = path.join(outputDir, "resilience-latest.json");
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  fs.writeFileSync(latestPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return outputPath;
}

function buildDryResult(args: ResilienceArgs): ResilienceResult {
  const checks: CheckResult[] = [
    {
      name: "health_endpoint_available",
      passed: true,
      statusCode: 200,
      detail: "Synthetic health check passed.",
    },
    {
      name: "query_requires_auth",
      passed: true,
      statusCode: 401,
      detail: "Synthetic unauthorized query correctly rejected.",
    },
    {
      name: "invalid_payload_rejected",
      passed: true,
      statusCode: 400,
      detail: "Synthetic invalid payload check passed.",
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    mode: "dry-run",
    baseUrl: args.baseUrl || "dry-run",
    passed: checks.every((check) => check.passed),
    checks,
  };
}

async function requestCheck(
  name: string,
  input: RequestInfo | URL,
  init: RequestInit,
  expectedStatuses: number[],
  successDetail: string,
): Promise<CheckResult> {
  try {
    const response = await fetch(input, init);
    const body = await response.text();
    const passed = expectedStatuses.includes(response.status);
    return {
      name,
      passed,
      statusCode: response.status,
      detail: passed ? successDetail : `Unexpected status=${response.status}, body=${body.slice(0, 300)}`,
    };
  } catch (error) {
    return {
      name,
      passed: false,
      statusCode: null,
      detail: error instanceof Error ? error.message : "Unknown request failure",
    };
  }
}

async function buildLiveResult(args: ResilienceArgs): Promise<ResilienceResult> {
  if (!args.baseUrl) {
    throw new Error("Missing --base-url for live resilience checks.");
  }

  const baseUrl = args.baseUrl.replace(/\/+$/, "");
  const checks: CheckResult[] = [];

  checks.push(
    await requestCheck(
      "health_endpoint_available",
      `${baseUrl}/api/health`,
      { method: "GET" },
      [200],
      "Health endpoint returned 200.",
    ),
  );

  checks.push(
    await requestCheck(
      "query_requires_auth",
      `${baseUrl}/api/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "Unauthorized probe query." }),
      },
      [401, 403],
      "Unauthorized request correctly rejected.",
    ),
  );

  if (args.token) {
    checks.push(
      await requestCheck(
        "invalid_payload_rejected",
        `${baseUrl}/api/query`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${args.token}`,
          },
          body: JSON.stringify({ query: "" }),
        },
        [400],
        "Invalid payload with auth was rejected.",
      ),
    );
  } else {
    checks.push({
      name: "invalid_payload_rejected",
      passed: false,
      statusCode: null,
      detail: "Skipped because --token was not provided.",
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    mode: "live",
    baseUrl: args.baseUrl,
    passed: checks.every((check) => check.passed),
    checks,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const result = args.mode === "dry-run" ? buildDryResult(args) : await buildLiveResult(args);
  const outputPath = writeResult(result);

  console.log(`Resilience checks completed (mode=${result.mode}).`);
  console.log(`Passed=${result.passed}`);
  for (const check of result.checks) {
    console.log(`- ${check.name}: ${check.passed ? "PASS" : "FAIL"} (${check.statusCode ?? "n/a"})`);
  }
  console.log(`Artifact: ${outputPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Resilience checks failed: ${message}`);
  process.exit(1);
});

