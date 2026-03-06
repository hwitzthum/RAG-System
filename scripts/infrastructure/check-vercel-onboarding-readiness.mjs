#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "../..");

function parseArgs(argv) {
  const args = {
    target: "presignup",
    envFile: ".env.staging",
    noFailOnGate: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--target") {
      args.target = argv[index + 1] ?? args.target;
      index += 1;
    } else if (token === "--env-file") {
      args.envFile = argv[index + 1] ?? args.envFile;
      index += 1;
    } else if (token === "--no-fail-on-gate") {
      args.noFailOnGate = true;
    }
  }

  if (!["presignup", "postlink"].includes(args.target)) {
    throw new Error("--target must be one of presignup|postlink");
  }

  return args;
}

function resolveRepoPath(targetPath) {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(ROOT_DIR, targetPath);
}

function parseDotEnv(rawText) {
  const parsed = {};
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }

    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
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

function commandAvailable(command, versionArg = "--version") {
  const result = spawnSync(command, [versionArg], { encoding: "utf8" });
  return result.status === 0;
}

function runVercelWhoAmI() {
  const result = spawnSync("vercel", ["whoami"], { encoding: "utf8", cwd: ROOT_DIR });
  if (result.status !== 0) {
    return { ok: false, user: "" };
  }
  return { ok: true, user: `${result.stdout ?? ""}`.trim() };
}

function runGitRemoteCheck() {
  const result = spawnSync("git", ["remote"], { encoding: "utf8", cwd: ROOT_DIR });
  if (result.status !== 0) {
    return { ok: false, remotes: [] };
  }
  const remotes = (result.stdout ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return { ok: remotes.length > 0, remotes };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeReport(payload) {
  const outputDir = resolveRepoPath("evaluation/reports");
  ensureDir(outputDir);

  const timestamp = payload.generatedAt.replace(/[:.]/g, "-");
  const filePath = path.join(outputDir, `vercel-onboarding-readiness-${timestamp}.json`);
  const latestPath = path.join(outputDir, "vercel-onboarding-readiness-latest.json");

  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  fs.writeFileSync(filePath, serialized, "utf8");
  fs.writeFileSync(latestPath, serialized, "utf8");
  return filePath;
}

function evaluate(args) {
  const envPath = resolveRepoPath(args.envFile);
  const envExists = fs.existsSync(envPath);
  const envValues = envExists ? parseDotEnv(fs.readFileSync(envPath, "utf8")) : {};

  const vercelJsonPath = resolveRepoPath("vercel.json");
  const vercelJsonExists = fs.existsSync(vercelJsonPath);
  let vercelJsonCronConfigured = false;
  let vercelJsonFrameworkValid = false;
  if (vercelJsonExists) {
    try {
      const raw = JSON.parse(fs.readFileSync(vercelJsonPath, "utf8"));
      vercelJsonCronConfigured = Array.isArray(raw.crons) && raw.crons.some((entry) => entry.path === "/api/internal/ingestion/run");
      vercelJsonFrameworkValid = raw.framework === "nextjs";
    } catch {
      vercelJsonCronConfigured = false;
      vercelJsonFrameworkValid = false;
    }
  }

  const projectPath = resolveRepoPath(".vercel/project.json");
  const projectLinked = fs.existsSync(projectPath);
  let projectIds = { orgId: "", projectId: "" };
  if (projectLinked) {
    try {
      const raw = JSON.parse(fs.readFileSync(projectPath, "utf8"));
      projectIds = {
        orgId: `${raw.orgId ?? ""}`.trim(),
        projectId: `${raw.projectId ?? ""}`.trim(),
      };
    } catch {
      projectIds = { orgId: "", projectId: "" };
    }
  }

  const hasVercelIdsInEnv =
    Boolean(envValues.VERCEL_ORG_ID) &&
    Boolean(envValues.VERCEL_PROJECT_ID) &&
    !isPlaceholder(envValues.VERCEL_ORG_ID) &&
    !isPlaceholder(envValues.VERCEL_PROJECT_ID);

  const ingestModeValid = envValues.INGESTION_RUNTIME_MODE === "vercel";
  const hasCronSecret = Boolean(envValues.CRON_SECRET) && !isPlaceholder(envValues.CRON_SECRET) && envValues.CRON_SECRET.length >= 16;

  const coreRequiredKeys = [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "OPENAI_BYOK_VAULT_KEY",
    "RAG_STORAGE_BUCKET",
  ];

  const missingCore = [];
  const placeholderCore = [];
  for (const key of coreRequiredKeys) {
    const value = envValues[key];
    if (!value || value.trim() === "") {
      missingCore.push(key);
    } else if (isPlaceholder(value)) {
      placeholderCore.push(key);
    }
  }
  const coreEnvConfigured = envExists && missingCore.length === 0 && placeholderCore.length === 0;

  const gitRemoteCheck = runGitRemoteCheck();
  const vercelAuthCheck = runVercelWhoAmI();
  const checks = [
    { name: "node_cli_available", passed: commandAvailable("node"), detail: "node --version available" },
    { name: "npm_cli_available", passed: commandAvailable("npm"), detail: "npm --version available" },
    { name: "vercel_cli_available", passed: commandAvailable("vercel"), detail: "vercel --version available" },
    { name: "vercel_authenticated", passed: vercelAuthCheck.ok, detail: vercelAuthCheck.ok ? `whoami=${vercelAuthCheck.user}` : "Run `vercel login`" },
    { name: "git_remote_configured", passed: gitRemoteCheck.ok, detail: gitRemoteCheck.ok ? gitRemoteCheck.remotes.join(", ") : "No git remotes configured" },
    { name: "staging_env_file_exists", passed: envExists, detail: envPath },
    {
      name: "staging_env_core_values_configured",
      passed: coreEnvConfigured,
      detail:
        coreEnvConfigured
          ? "Core staging env keys are configured."
          : `Missing core keys=${missingCore.join(", ") || "none"}; placeholders=${placeholderCore.join(", ") || "none"}`,
    },
    { name: "vercel_json_framework_nextjs", passed: vercelJsonFrameworkValid, detail: vercelJsonPath },
    { name: "vercel_json_cron_configured", passed: vercelJsonCronConfigured, detail: "/api/internal/ingestion/run cron configured" },
    { name: "vercel_project_linked", passed: projectLinked, detail: projectPath },
    {
      name: "vercel_project_ids_present",
      passed: Boolean(projectIds.orgId && projectIds.projectId),
      detail: `orgId=${projectIds.orgId || "missing"}, projectId=${projectIds.projectId || "missing"}`,
    },
    { name: "staging_env_vercel_ids_configured", passed: hasVercelIdsInEnv, detail: "VERCEL_ORG_ID and VERCEL_PROJECT_ID are non-placeholder" },
    { name: "staging_env_ingestion_mode_vercel", passed: ingestModeValid, detail: `INGESTION_RUNTIME_MODE=${envValues.INGESTION_RUNTIME_MODE || "missing"}` },
    { name: "staging_env_cron_secret_valid", passed: hasCronSecret, detail: "CRON_SECRET exists and length >=16" },
  ];

  const checkByName = Object.fromEntries(checks.map((check) => [check.name, check]));
  const preSignupGate =
    checkByName.node_cli_available.passed &&
    checkByName.npm_cli_available.passed &&
    checkByName.vercel_cli_available.passed &&
    checkByName.git_remote_configured.passed &&
    checkByName.staging_env_file_exists.passed &&
    checkByName.vercel_json_framework_nextjs.passed &&
    checkByName.vercel_json_cron_configured.passed;

  const postLinkGate =
    preSignupGate &&
    checkByName.vercel_authenticated.passed &&
    checkByName.vercel_project_linked.passed &&
    checkByName.vercel_project_ids_present.passed &&
    checkByName.staging_env_core_values_configured.passed &&
    checkByName.staging_env_vercel_ids_configured.passed &&
    checkByName.staging_env_ingestion_mode_vercel.passed &&
    checkByName.staging_env_cron_secret_valid.passed;

  const targetPassed = args.target === "presignup" ? preSignupGate : postLinkGate;

  const nextSteps = [];
  if (!checkByName.vercel_cli_available.passed) {
    nextSteps.push("Install Vercel CLI: npm i -g vercel");
  }
  if (!checkByName.vercel_authenticated.passed && checkByName.vercel_cli_available.passed) {
    nextSteps.push("Authenticate Vercel CLI: vercel login");
  }
  if (!checkByName.git_remote_configured.passed) {
    nextSteps.push("Configure a git remote before importing into Vercel.");
  }
  if (!checkByName.staging_env_file_exists.passed) {
    nextSteps.push("Create .env.staging from .env.staging.example.");
  }
  if (!checkByName.vercel_project_linked.passed || !checkByName.vercel_project_ids_present.passed) {
    nextSteps.push("After signup/login run: vercel login && vercel link");
  }
  if (!checkByName.staging_env_vercel_ids_configured.passed && checkByName.vercel_project_ids_present.passed) {
    nextSteps.push("Run: npm run infra:vercel:sync-ids");
  }
  if (!checkByName.staging_env_core_values_configured.passed) {
    nextSteps.push("Populate non-placeholder core values in .env.staging and rerun readiness.");
  }
  if (!checkByName.staging_env_cron_secret_valid.passed) {
    nextSteps.push("Set CRON_SECRET in .env.staging to a random 16+ character secret.");
  }

  return {
    generatedAt: new Date().toISOString(),
    target: args.target,
    passed: targetPassed,
    gates: {
      preSignupGate,
      postLinkGate,
    },
    checks,
    nextSteps,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const report = evaluate(args);
  const artifactPath = writeReport(report);

  console.log(`Vercel onboarding readiness completed (target=${args.target}).`);
  console.log(`Passed=${report.passed}`);
  console.log(`Gate pre-signup=${report.gates.preSignupGate}, post-link=${report.gates.postLinkGate}`);
  console.log(`Artifact: ${artifactPath}`);
  if (report.nextSteps.length > 0) {
    console.log("Next steps:");
    for (const step of report.nextSteps) {
      console.log(`- ${step}`);
    }
  }

  if (!report.passed && !args.noFailOnGate) {
    process.exit(2);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Vercel onboarding readiness failed: ${message}`);
  process.exit(1);
}
