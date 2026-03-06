#!/usr/bin/env tsx

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type MatrixMode = "precutover" | "strict";

type ScriptArgs = {
  mode: MatrixMode;
  baseUrl: string;
  token: string;
  soakWindowHours: number;
  soakMinCompletedJobs: number;
  soakMinReadyDocuments: number;
  soakMaxP95CompletionMs: number;
  soakMaxDeadLetterGrowth: number;
  soakMaxDuplicateWriteErrors: number;
  continueOnError: boolean;
};

type MatrixStep = {
  name: string;
  command: string[];
  required: boolean;
};

type StepResult = {
  name: string;
  command: string;
  required: boolean;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
};

type MatrixReport = {
  generatedAt: string;
  mode: MatrixMode;
  passed: boolean;
  summary: {
    totalSteps: number;
    requiredSteps: number;
    passedSteps: number;
    failedRequiredSteps: number;
  };
  steps: StepResult[];
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
    mode: "precutover",
    baseUrl: "",
    token: "",
    soakWindowHours: 24,
    soakMinCompletedJobs: 25,
    soakMinReadyDocuments: 25,
    soakMaxP95CompletionMs: 900_000,
    soakMaxDeadLetterGrowth: 0,
    soakMaxDuplicateWriteErrors: 0,
    continueOnError: true,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--mode") {
      const mode = argv[index + 1];
      if (mode === "precutover" || mode === "strict") {
        args.mode = mode;
      }
      index += 1;
    } else if (token === "--base-url") {
      args.baseUrl = argv[index + 1] ?? args.baseUrl;
      index += 1;
    } else if (token === "--token") {
      args.token = argv[index + 1] ?? args.token;
      index += 1;
    } else if (token === "--soak-window-hours") {
      args.soakWindowHours = parsePositiveInt(argv[index + 1], args.soakWindowHours);
      index += 1;
    } else if (token === "--soak-min-completed-jobs") {
      args.soakMinCompletedJobs = parsePositiveInt(argv[index + 1], args.soakMinCompletedJobs);
      index += 1;
    } else if (token === "--soak-min-ready-documents") {
      args.soakMinReadyDocuments = parsePositiveInt(argv[index + 1], args.soakMinReadyDocuments);
      index += 1;
    } else if (token === "--soak-max-p95-completion-ms") {
      args.soakMaxP95CompletionMs = parsePositiveInt(argv[index + 1], args.soakMaxP95CompletionMs);
      index += 1;
    } else if (token === "--soak-max-dead-letter-growth") {
      args.soakMaxDeadLetterGrowth = Math.max(0, Number.parseInt(argv[index + 1] ?? "0", 10) || 0);
      index += 1;
    } else if (token === "--soak-max-duplicate-write-errors") {
      args.soakMaxDuplicateWriteErrors = Math.max(0, Number.parseInt(argv[index + 1] ?? "0", 10) || 0);
      index += 1;
    } else if (token === "--continue-on-error") {
      args.continueOnError = true;
    } else if (token === "--stop-on-error") {
      args.continueOnError = false;
    }
  }

  return args;
}

function buildSoakArgs(args: ScriptArgs): string[] {
  return [
    "--window-hours",
    `${args.soakWindowHours}`,
    "--min-completed-jobs",
    `${args.soakMinCompletedJobs}`,
    "--min-ready-documents",
    `${args.soakMinReadyDocuments}`,
    "--max-p95-completion-ms",
    `${args.soakMaxP95CompletionMs}`,
    "--max-dead-letter-growth",
    `${args.soakMaxDeadLetterGrowth}`,
    "--max-duplicate-write-errors",
    `${args.soakMaxDuplicateWriteErrors}`,
  ];
}

function buildSteps(args: ScriptArgs): MatrixStep[] {
  const soakArgs = buildSoakArgs(args);
  const common: MatrixStep[] = [
    { name: "check", command: ["npm", "run", "check"], required: true },
    { name: "test_security", command: ["npm", "run", "test:security"], required: true },
  ];

  if (args.mode === "precutover") {
    return [
      ...common,
      { name: "benchmark_dry", command: ["npm", "run", "eval:benchmark:dry"], required: true },
      { name: "soak_verify_live", command: ["npm", "run", "perf:soak:verify", "--", ...soakArgs], required: true },
      { name: "release_readiness_precutover", command: ["npm", "run", "release:readiness:precutover"], required: true },
    ];
  }

  if (!args.baseUrl) {
    throw new Error("--base-url is required in strict mode.");
  }
  if (!args.token) {
    throw new Error("--token is required in strict mode.");
  }

  return [
    ...common,
    { name: "benchmark_live", command: ["npm", "run", "eval:benchmark"], required: true },
    { name: "observability_validate", command: ["npm", "run", "obs:validate"], required: true },
    { name: "ingestion_health_live", command: ["npm", "run", "obs:ingestion:check"], required: true },
    {
      name: "load_test_live",
      command: ["npm", "run", "perf:load", "--", "--base-url", args.baseUrl, "--token", args.token],
      required: true,
    },
    {
      name: "resilience_live",
      command: ["npm", "run", "perf:resilience", "--", "--base-url", args.baseUrl, "--token", args.token],
      required: true,
    },
    { name: "soak_verify_live", command: ["npm", "run", "perf:soak:verify", "--", ...soakArgs], required: true },
    { name: "release_readiness_strict", command: ["npm", "run", "release:readiness"], required: true },
  ];
}

async function runCommand(command: string[]): Promise<{ exitCode: number | null; durationMs: number }> {
  const [executable, ...args] = command;
  const startedAt = Date.now();

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(executable ?? "", args, {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve(code);
    });
  });

  return { exitCode, durationMs: Date.now() - startedAt };
}

function writeReport(report: MatrixReport): string {
  const outputDir = path.resolve("evaluation/reports");
  fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = report.generatedAt.replace(/[:.]/g, "-");
  const outputPath = path.join(outputDir, `validation-matrix-${report.mode}-${timestamp}.json`);
  const latestPath = path.join(outputDir, `validation-matrix-${report.mode}-latest.json`);
  const latestGenericPath = path.join(outputDir, "validation-matrix-latest.json");

  const payload = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(outputPath, payload, "utf8");
  fs.writeFileSync(latestPath, payload, "utf8");
  fs.writeFileSync(latestGenericPath, payload, "utf8");
  return outputPath;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const steps = buildSteps(args);
  const results: StepResult[] = [];

  for (const step of steps) {
    const commandText = step.command.join(" ");
    console.log(`\n=== Running step: ${step.name} ===`);
    console.log(`Command: ${commandText}`);

    let exitCode: number | null = null;
    let durationMs = 0;
    try {
      const runResult = await runCommand(step.command);
      exitCode = runResult.exitCode;
      durationMs = runResult.durationMs;
    } catch (error) {
      exitCode = 1;
      durationMs = 0;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Step failed to execute: ${message}`);
    }

    const passed = exitCode === 0;
    results.push({
      name: step.name,
      command: commandText,
      required: step.required,
      passed,
      exitCode,
      durationMs,
    });

    if (!passed && !args.continueOnError) {
      console.error(`Stopping on first failure due to --stop-on-error (${step.name}).`);
      break;
    }
  }

  const requiredSteps = results.filter((step) => step.required);
  const passedSteps = results.filter((step) => step.passed);
  const failedRequiredSteps = requiredSteps.filter((step) => !step.passed);

  const report: MatrixReport = {
    generatedAt: new Date().toISOString(),
    mode: args.mode,
    passed: failedRequiredSteps.length === 0,
    summary: {
      totalSteps: results.length,
      requiredSteps: requiredSteps.length,
      passedSteps: passedSteps.length,
      failedRequiredSteps: failedRequiredSteps.length,
    },
    steps: results,
  };

  const artifactPath = writeReport(report);
  console.log(`\nValidation matrix completed (mode=${args.mode}).`);
  console.log(`Overall status: ${report.passed ? "PASS" : "FAIL"}`);
  console.log(`Artifact: ${artifactPath}`);

  if (!report.passed) {
    process.exit(2);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Validation matrix runner failed: ${message}`);
  process.exit(1);
});
