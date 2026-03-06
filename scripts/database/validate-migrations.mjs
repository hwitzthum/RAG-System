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

if (files.length < 6) {
  fail(
    "Expected at least six migration files (phase 2 + phase 3 + phase 7 + phase 12 + phase 12 ingestion RPC + ACL hardening).\n",
  );
}

const expectedFiles = [
  "202603060001_phase2_bootstrap.sql",
  "202603060002_phase3_core_schema.sql",
  "202603060003_phase7_retrieval_rpc.sql",
  "202603060004_phase12_openai_byok_vault.sql",
  "202603060005_phase12_ingestion_job_rpc.sql",
  "202603060006_phase12_ingestion_job_rpc_acl_fix.sql",
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

const phase12RpcPath = path.join(migrationsDir, "202603060005_phase12_ingestion_job_rpc.sql");
const phase12RpcSql = fs.readFileSync(phase12RpcPath, "utf8");

const phase12RpcPatterns = [
  /create or replace function public\.claim_ingestion_jobs/i,
  /for update skip locked/i,
  /create or replace function public\.complete_ingestion_job/i,
  /create or replace function public\.fail_ingestion_job/i,
  /grant execute on function public\.claim_ingestion_jobs/i,
  /grant execute on function public\.complete_ingestion_job/i,
  /grant execute on function public\.fail_ingestion_job/i,
];

const missingPhase12RpcPatterns = phase12RpcPatterns.filter((pattern) => !pattern.test(phase12RpcSql));
if (missingPhase12RpcPatterns.length > 0) {
  fail(
    `Phase 12 ingestion RPC migration is missing required elements:\n${missingPhase12RpcPatterns
      .map((pattern) => `- ${pattern}`)
      .join("\n")}`,
  );
}

const phase12AclPath = path.join(migrationsDir, "202603060006_phase12_ingestion_job_rpc_acl_fix.sql");
const phase12AclSql = fs.readFileSync(phase12AclPath, "utf8");

const phase12AclPatterns = [
  /revoke execute on function public\.claim_ingestion_jobs/i,
  /revoke execute on function public\.complete_ingestion_job/i,
  /revoke execute on function public\.fail_ingestion_job/i,
  /from anon/i,
  /from authenticated/i,
  /grant execute on function public\.claim_ingestion_jobs/i,
  /grant execute on function public\.complete_ingestion_job/i,
  /grant execute on function public\.fail_ingestion_job/i,
  /to service_role/i,
];

const missingPhase12AclPatterns = phase12AclPatterns.filter((pattern) => !pattern.test(phase12AclSql));
if (missingPhase12AclPatterns.length > 0) {
  fail(
    `Phase 12 ingestion RPC ACL migration is missing required elements:\n${missingPhase12AclPatterns
      .map((pattern) => `- ${pattern}`)
      .join("\n")}`,
  );
}

console.log("Migration validation passed.");
console.log(`Validated files:\n- ${expectedFiles.join("\n- ")}`);
