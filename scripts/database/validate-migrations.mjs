#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const migrationsDir = path.join(ROOT, "supabase", "migrations");

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!fs.existsSync(migrationsDir)) {
  fail(`Missing migrations directory: ${migrationsDir}`);
}

const files = fs
  .readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();

if (files.length < 4) {
  fail("Expected at least four migration files (phase 2 + phase 3 + phase 7 + phase 12).\n");
}

const expectedFiles = [
  "202603060001_phase2_bootstrap.sql",
  "202603060002_phase3_core_schema.sql",
  "202603060003_phase7_retrieval_rpc.sql",
  "202603060004_phase12_openai_byok_vault.sql",
];

for (const expected of expectedFiles) {
  if (!files.includes(expected)) {
    fail(`Missing required migration: ${expected}`);
  }
}

const phase3Path = path.join(migrationsDir, "202603060002_phase3_core_schema.sql");
const phase3Sql = fs.readFileSync(phase3Path, "utf8");

const requiredPatterns = [
  /create table if not exists public\.documents/i,
  /create table if not exists public\.document_chunks/i,
  /create table if not exists public\.retrieval_cache/i,
  /create table if not exists public\.ingestion_jobs/i,
  /create table if not exists public\.query_history/i,
  /using ivfflat \(embedding vector_cosine_ops\)/i,
  /using gin \(tsv\)/i,
  /alter table public\.documents enable row level security/i,
  /alter table public\.document_chunks enable row level security/i,
  /alter table public\.retrieval_cache enable row level security/i,
  /alter table public\.ingestion_jobs enable row level security/i,
  /alter table public\.query_history enable row level security/i,
  /policy query_history_user_select/i,
  /policy documents_select_reader_admin/i,
  /policy ingestion_jobs_admin_full_access/i,
];

const missingPatterns = requiredPatterns.filter((pattern) => !pattern.test(phase3Sql));
if (missingPatterns.length > 0) {
  fail(
    `Phase 3 migration is missing required schema elements:\n${missingPatterns
      .map((pattern) => `- ${pattern}`)
      .join("\n")}`,
  );
}

const phase7Path = path.join(migrationsDir, "202603060003_phase7_retrieval_rpc.sql");
const phase7Sql = fs.readFileSync(phase7Path, "utf8");

const phase7Patterns = [
  /create or replace function public\.match_document_chunks/i,
  /returns table/i,
  /order by dc\.embedding <=> query_embedding/i,
  /grant execute on function public\.match_document_chunks/i,
];

const missingPhase7Patterns = phase7Patterns.filter((pattern) => !pattern.test(phase7Sql));
if (missingPhase7Patterns.length > 0) {
  fail(
    `Phase 7 migration is missing retrieval RPC elements:\n${missingPhase7Patterns
      .map((pattern) => `- ${pattern}`)
      .join("\n")}`,
  );
}

const phase12Path = path.join(migrationsDir, "202603060004_phase12_openai_byok_vault.sql");
const phase12Sql = fs.readFileSync(phase12Path, "utf8");

const phase12Patterns = [
  /create table if not exists public\.user_openai_keys/i,
  /encrypted_key text not null/i,
  /auth_tag text not null/i,
  /alter table public\.user_openai_keys enable row level security/i,
  /policy user_openai_keys_owner_select/i,
  /policy user_openai_keys_owner_insert/i,
  /policy user_openai_keys_owner_update/i,
  /policy user_openai_keys_owner_delete/i,
];

const missingPhase12Patterns = phase12Patterns.filter((pattern) => !pattern.test(phase12Sql));
if (missingPhase12Patterns.length > 0) {
  fail(
    `Phase 12 migration is missing BYOK vault elements:\n${missingPhase12Patterns
      .map((pattern) => `- ${pattern}`)
      .join("\n")}`,
  );
}

console.log("Migration validation passed.");
console.log(`Validated files:\n- ${expectedFiles.join("\n- ")}`);
