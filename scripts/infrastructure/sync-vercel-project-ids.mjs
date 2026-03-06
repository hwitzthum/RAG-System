#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "../..");

function parseArgs(argv) {
  const args = {
    envFile: ".env.staging",
    envTemplate: ".env.staging.example",
    projectFile: ".vercel/project.json",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--env-file") {
      args.envFile = argv[index + 1] ?? args.envFile;
      index += 1;
    } else if (token === "--env-template") {
      args.envTemplate = argv[index + 1] ?? args.envTemplate;
      index += 1;
    } else if (token === "--project-file") {
      args.projectFile = argv[index + 1] ?? args.projectFile;
      index += 1;
    }
  }

  return args;
}

function resolveRepoPath(targetPath) {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(ROOT_DIR, targetPath);
}

function ensureEnvFileExists(envPath, templatePath) {
  if (fs.existsSync(envPath)) {
    return;
  }

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Environment file ${envPath} does not exist and template ${templatePath} was not found.`);
  }

  fs.copyFileSync(templatePath, envPath);
}

function upsertKey(lines, key, value) {
  const keyPrefix = `${key}=`;
  const nextLines = [...lines];
  const index = nextLines.findIndex((line) => line.startsWith(keyPrefix));
  if (index >= 0) {
    nextLines[index] = `${key}=${value}`;
  } else {
    nextLines.push(`${key}=${value}`);
  }
  return nextLines;
}

function main() {
  const args = parseArgs(process.argv);
  const envPath = resolveRepoPath(args.envFile);
  const templatePath = resolveRepoPath(args.envTemplate);
  const projectPath = resolveRepoPath(args.projectFile);

  if (!fs.existsSync(projectPath)) {
    throw new Error(`Vercel project file not found at ${projectPath}. Run "vercel link" first.`);
  }

  const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  const orgId = `${project.orgId ?? ""}`.trim();
  const projectId = `${project.projectId ?? ""}`.trim();
  if (!orgId || !projectId) {
    throw new Error(`project.json missing orgId or projectId at ${projectPath}`);
  }

  ensureEnvFileExists(envPath, templatePath);
  const existing = fs.readFileSync(envPath, "utf8");
  let lines = existing.split(/\r?\n/);
  lines = upsertKey(lines, "VERCEL_ORG_ID", orgId);
  lines = upsertKey(lines, "VERCEL_PROJECT_ID", projectId);

  const output = `${lines.join("\n").replace(/\n+$/g, "\n")}`;
  fs.writeFileSync(envPath, output, "utf8");

  console.log(`Synced Vercel project IDs into ${envPath}`);
  console.log(`VERCEL_ORG_ID=${orgId}`);
  console.log(`VERCEL_PROJECT_ID=${projectId}`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to sync Vercel project IDs: ${message}`);
  process.exit(1);
}
