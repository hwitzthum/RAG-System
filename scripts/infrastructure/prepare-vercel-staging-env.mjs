#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "../..");

function parseArgs(argv) {
  const args = {
    envFile: ".env.staging",
    envTemplate: ".env.staging.example",
    rotateCronSecret: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--env-file") {
      args.envFile = argv[index + 1] ?? args.envFile;
      index += 1;
    } else if (token === "--env-template") {
      args.envTemplate = argv[index + 1] ?? args.envTemplate;
      index += 1;
    } else if (token === "--rotate-cron-secret") {
      args.rotateCronSecret = true;
    }
  }

  return args;
}

function resolveRepoPath(targetPath) {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(ROOT_DIR, targetPath);
}

function isPlaceholder(value) {
  if (!value) {
    return true;
  }
  const lowered = value.toLowerCase();
  return (
    lowered.includes("your-") ||
    lowered.includes("changeme") ||
    lowered.includes("example") ||
    lowered === "replace-me"
  );
}

function ensureEnvFileExists(envPath, templatePath) {
  if (fs.existsSync(envPath)) {
    return;
  }
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Missing ${envPath} and template ${templatePath}.`);
  }
  fs.copyFileSync(templatePath, envPath);
}

function upsertKey(lines, key, value) {
  const keyPrefix = `${key}=`;
  const index = lines.findIndex((line) => line.startsWith(keyPrefix));
  if (index >= 0) {
    lines[index] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }
}

function extractValue(lines, key) {
  const keyPrefix = `${key}=`;
  const line = lines.find((entry) => entry.startsWith(keyPrefix));
  if (!line) {
    return "";
  }
  return line.slice(keyPrefix.length).trim();
}

function generateCronSecret() {
  return crypto.randomBytes(24).toString("hex");
}

function main() {
  const args = parseArgs(process.argv);
  const envPath = resolveRepoPath(args.envFile);
  const templatePath = resolveRepoPath(args.envTemplate);

  ensureEnvFileExists(envPath, templatePath);
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

  upsertKey(lines, "INGESTION_RUNTIME_MODE", "vercel");

  const currentCron = extractValue(lines, "CRON_SECRET");
  const shouldRotate =
    args.rotateCronSecret || !currentCron || currentCron.length < 16 || isPlaceholder(currentCron);
  if (shouldRotate) {
    upsertKey(lines, "CRON_SECRET", generateCronSecret());
  }

  const normalized = `${lines.join("\n").replace(/\n+$/g, "\n")}`;
  fs.writeFileSync(envPath, normalized, "utf8");

  console.log(`Prepared staging env for Vercel at ${envPath}`);
  console.log(`INGESTION_RUNTIME_MODE=vercel`);
  console.log(`CRON_SECRET ${shouldRotate ? "generated/rotated" : "kept existing value"}`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to prepare staging env: ${message}`);
  process.exit(1);
}
