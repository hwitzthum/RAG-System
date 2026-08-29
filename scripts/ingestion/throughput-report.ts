#!/usr/bin/env node

/**
 * Measured ingestion throughput, per completed job, from `ingestion_jobs`.
 *
 * Reads what the worker actually recorded (`processing_duration_ms`,
 * `chunks_total`) rather than projecting from per-batch timings, so the
 * numbers here are end-to-end wall time for a document: extraction, context
 * generation, embedding and storage across every batch the job spanned.
 *
 * Usage:
 *   npm run ingestion:throughput            (dotenv loads .env.local)
 *   npm run ingestion:throughput -- --limit 50
 */

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type JobRow = Pick<
  Database["public"]["Tables"]["ingestion_jobs"]["Row"],
  | "document_id"
  | "status"
  | "chunks_total"
  | "processing_duration_ms"
  | "processing_started_at"
  | "updated_at"
>;

function parseLimit(argv: string[]): number {
  const index = argv.indexOf("--limit");
  const parsed = index >= 0 ? Number.parseInt(argv[index + 1] ?? "", 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  }
  const supabase = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const limit = parseLimit(process.argv);
  const { data: jobs, error } = await supabase
    .from("ingestion_jobs")
    .select(
      "document_id,status,chunks_total,processing_duration_ms,processing_started_at,updated_at",
    )
    .eq("status", "completed")
    .not("processing_duration_ms", "is", null)
    .order("updated_at", { ascending: false })
    .limit(limit)
    .returns<JobRow[]>();
  if (error) {
    throw new Error(`Failed to load ingestion jobs: ${error.message}`);
  }

  const documentIds = [...new Set((jobs ?? []).map((job) => job.document_id))];
  const { data: documents, error: documentError } = await supabase
    .from("documents")
    .select("id,title")
    .in("id", documentIds);
  if (documentError) {
    throw new Error(`Failed to load documents: ${documentError.message}`);
  }
  const titles = new Map(
    (documents ?? []).map((document) => [document.id, document.title ?? ""]),
  );

  const rows = (jobs ?? [])
    .filter(
      (job) =>
        typeof job.processing_duration_ms === "number" &&
        job.processing_duration_ms > 0 &&
        typeof job.chunks_total === "number" &&
        job.chunks_total > 0,
    )
    .map((job) => {
      const seconds = (job.processing_duration_ms as number) / 1000;
      const chunks = job.chunks_total as number;
      return {
        completed: job.updated_at.slice(0, 16).replace("T", " "),
        document: (titles.get(job.document_id) ?? job.document_id).slice(0, 44),
        chunks,
        seconds: Math.round(seconds),
        chunksPerMinute: Math.round((chunks / seconds) * 60 * 10) / 10,
      };
    });

  if (rows.length === 0) {
    console.log("No completed jobs with recorded durations.");
    return;
  }

  console.table(rows);

  const totalChunks = rows.reduce((sum, row) => sum + row.chunks, 0);
  const totalSeconds = rows.reduce((sum, row) => sum + row.seconds, 0);
  const largest = rows.reduce((best, row) =>
    row.chunks > best.chunks ? row : best,
  );
  console.log(
    `\nAggregate: ${totalChunks} chunks in ${Math.round(totalSeconds)}s = ${Math.round((totalChunks / totalSeconds) * 60 * 10) / 10} chunks/min over ${rows.length} jobs.`,
  );
  console.log(
    `Largest document: "${largest.document}" — ${largest.chunks} chunks in ${largest.seconds}s (${largest.chunksPerMinute} chunks/min).`,
  );
}

main().catch((error) => {
  console.error(
    `Throughput report failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
