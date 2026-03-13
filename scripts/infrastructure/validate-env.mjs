#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { target: "web", file: "" };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--target") {
      args.target = argv[i + 1] ?? args.target;
      i += 1;
    } else if (token === "--file") {
      args.file = argv[i + 1] ?? "";
      i += 1;
    }
  }

  return args;
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

function loadEnvFile(filepath) {
  if (!filepath) {
    return {};
  }

  const absolute = path.resolve(filepath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Environment file not found: ${absolute}`);
  }

  return parseDotEnv(fs.readFileSync(absolute, "utf8"));
}

function requiredKeysByTarget(target) {
  if (target === "staging") {
    return [
      "NODE_ENV",
      "NEXT_PUBLIC_APP_NAME",
      "INGESTION_BATCH_SIZE",
      "INGESTION_LOCK_TIMEOUT_SECONDS",
      "SUPABASE_URL",
      "SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_PROJECT_REF",
      "SUPABASE_DB_PASSWORD",
      "AUTH_RATE_LIMIT_WINDOW_SECONDS",
      "AUTH_RATE_LIMIT_MAX_REQUESTS",
      "OPENAI_API_KEY",
      "OPENAI_BYOK_VAULT_KEY",
      "RAG_QUERY_EMBEDDING_MODEL",
      "RAG_RETRIEVAL_VERSION",
      "RAG_RRF_K",
      "RAG_RERANK_POOL_SIZE",
      "RAG_LLM_MODEL",
      "RAG_LLM_MAX_OUTPUT_TOKENS",
      "RAG_MIN_EVIDENCE_CHUNKS",
      "RAG_MIN_RERANK_SCORE",
      "RAG_DEFAULT_TOP_K",
      "RAG_CACHE_TTL_SECONDS",
      "RAG_MAX_UPLOAD_BYTES",
      "RAG_STORAGE_BUCKET",
      "VERCEL_ORG_ID",
      "VERCEL_PROJECT_ID"
    ];
  }

  return [
    "NODE_ENV",
    "NEXT_PUBLIC_APP_NAME",
    "INGESTION_BATCH_SIZE",
    "INGESTION_LOCK_TIMEOUT_SECONDS",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "AUTH_RATE_LIMIT_WINDOW_SECONDS",
    "AUTH_RATE_LIMIT_MAX_REQUESTS",
    "OPENAI_API_KEY",
    "OPENAI_BYOK_VAULT_KEY",
    "RAG_QUERY_EMBEDDING_MODEL",
    "RAG_RETRIEVAL_VERSION",
    "RAG_RRF_K",
    "RAG_RERANK_POOL_SIZE",
    "RAG_LLM_MODEL",
    "RAG_LLM_MAX_OUTPUT_TOKENS",
    "RAG_MIN_EVIDENCE_CHUNKS",
    "RAG_MIN_RERANK_SCORE",
    "RAG_DEFAULT_TOP_K",
    "RAG_CACHE_TTL_SECONDS",
    "RAG_MAX_UPLOAD_BYTES",
    "RAG_STORAGE_BUCKET"
  ];
}

function isPlaceholder(value) {
  const lowered = value.toLowerCase();
  return (
    lowered.includes("your-") ||
    lowered.includes("changeme") ||
    lowered.includes("example") ||
    lowered === "replace-me"
  );
}

function isPositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0;
}

function isValidBase64AesKey(value) {
  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
}

function run() {
  const { target, file } = parseArgs(process.argv);
  if (!["web", "worker", "staging"].includes(target)) {
    console.error(`Unsupported target: ${target}`);
    process.exit(1);
  }

  const fileValues = loadEnvFile(file);
  const env = { ...process.env, ...fileValues };
  const required = requiredKeysByTarget(target);

  const missing = [];
  const placeholder = [];
  const invalid = [];

  for (const key of required) {
    const value = env[key];
    if (!value || value.trim() === "") {
      missing.push(key);
      continue;
    }
    if (isPlaceholder(value)) {
      placeholder.push(key);
    }
  }

  if (env.SUPABASE_URL && !env.SUPABASE_URL.startsWith("https://")) {
    invalid.push("SUPABASE_URL must start with https://");
  }

  if (!env.SUPABASE_JWT_SECRET && !env.AUTH_JWKS_URL) {
    invalid.push("Either SUPABASE_JWT_SECRET or AUTH_JWKS_URL must be configured");
  }

  if ((target === "staging" || process.env.VERCEL === "1" || process.env.VERCEL === "true") && !env.CRON_SECRET) {
    invalid.push("CRON_SECRET must be configured for deployment environments that expose the ingestion trigger");
  }

  if (env.CRON_SECRET && env.CRON_SECRET.length < 16) {
    invalid.push("CRON_SECRET must be at least 16 characters");
  }

  if (env.OPENAI_BYOK_VAULT_KEY && !isValidBase64AesKey(env.OPENAI_BYOK_VAULT_KEY)) {
    invalid.push("OPENAI_BYOK_VAULT_KEY must be a base64-encoded 32-byte key");
  }

  if (env.AUTH_JWKS_URL && !env.AUTH_JWKS_URL.startsWith("https://")) {
    invalid.push("AUTH_JWKS_URL must start with https://");
  }

  for (const intKey of [
    "RAG_RETRIEVAL_VERSION",
    "RAG_RRF_K",
    "RAG_RERANK_POOL_SIZE",
    "RAG_LLM_MAX_OUTPUT_TOKENS",
    "RAG_MIN_EVIDENCE_CHUNKS",
    "RAG_DEFAULT_TOP_K",
    "RAG_CACHE_TTL_SECONDS",
    "RAG_MAX_UPLOAD_BYTES",
    "WORKER_POLL_INTERVAL_SECONDS",
    "WORKER_MAX_RETRIES",
    "INGESTION_BATCH_SIZE",
    "INGESTION_LOCK_TIMEOUT_SECONDS",
    "OPENAI_BYOK_VAULT_KEY_VERSION",
  ]) {
    if (env[intKey] && !isPositiveInt(env[intKey])) {
      invalid.push(`${intKey} must be a positive integer`);
    }
  }

  if (env.RAG_MIN_RERANK_SCORE) {
    const score = Number.parseFloat(env.RAG_MIN_RERANK_SCORE);
    if (!Number.isFinite(score) || score < 0) {
      invalid.push("RAG_MIN_RERANK_SCORE must be a non-negative number");
    }
  }

  for (const intKey of ["AUTH_RATE_LIMIT_WINDOW_SECONDS", "AUTH_RATE_LIMIT_MAX_REQUESTS"]) {
    if (target !== "worker" && env[intKey] && !isPositiveInt(env[intKey])) {
      invalid.push(`${intKey} must be a positive integer`);
    }
  }

  if (env.NODE_ENV && !["development", "test", "production"].includes(env.NODE_ENV)) {
    invalid.push("NODE_ENV must be one of development|test|production");
  }

  if (env.NODE_ENV === "production" && env.AUTH_DEV_INSECURE_BYPASS === "true") {
    invalid.push("AUTH_DEV_INSECURE_BYPASS cannot be true in production");
  }

  if (missing.length || placeholder.length || invalid.length) {
    console.error("Environment validation failed.");
    if (missing.length) {
      console.error(`Missing keys: ${missing.join(", ")}`);
    }
    if (placeholder.length) {
      console.error(`Placeholder values detected for: ${placeholder.join(", ")}`);
    }
    if (invalid.length) {
      console.error(`Invalid values: ${invalid.join("; ")}`);
    }
    process.exit(1);
  }

  console.log(`Environment validation passed for target=${target}.`);
}

run();
