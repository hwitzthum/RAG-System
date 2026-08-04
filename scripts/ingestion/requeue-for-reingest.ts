#!/usr/bin/env tsx

/**
 * Requeues READY documents for a full re-ingest so pipeline improvements
 * (document-summary contextual enrichment, BPE chunk budgets, provenance
 * columns) apply to the existing corpus. Bumps each document's
 * ingestion_version and inserts a fresh queued job with the matching
 * idempotency key; the ingestion worker then re-extracts, re-chunks,
 * re-enriches, and re-embeds the document (OpenAI + context-LLM cost applies).
 *
 * Dry-run by default. Usage:
 *   npm run ingestion:reingest             — print the plan
 *   npm run ingestion:reingest -- --apply  — requeue all ready documents
 *   ... --apply --documents id1,id2        — requeue a subset
 *
 * After applying, run the worker until the queue drains:
 *   npm run ingestion:worker:once  (repeat, or npm run ingestion:worker)
 */

type DocumentRow = {
  id: string;
  title: string | null;
  sha256: string;
  ingestion_version: number;
  status: string;
};

function parseArgs(argv: string[]): {
  apply: boolean;
  documents: string[] | null;
} {
  let apply = false;
  let documents: string[] | null = null;
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--apply") {
      apply = true;
    } else if (argv[index] === "--documents") {
      const raw = argv[index + 1] ?? "";
      documents = raw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      index += 1;
    }
  }
  return { apply, documents };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv);
  const { getSupabaseAdminClient } = await import("../../lib/supabase/admin");
  const supabase = getSupabaseAdminClient();

  let query = supabase
    .from("documents")
    .select("id,title,sha256,ingestion_version,status")
    .eq("status", "ready");
  if (args.documents && args.documents.length > 0) {
    query = query.in("id", args.documents);
  }

  const { data: documents, error } = await query.returns<DocumentRow[]>();
  if (error) {
    throw new Error(`Failed to list documents: ${error.message}`);
  }
  if (!documents || documents.length === 0) {
    console.log("No ready documents matched; nothing to requeue.");
    return;
  }

  for (const document of documents) {
    const nextVersion = document.ingestion_version + 1;
    console.log(
      `${args.apply ? "REQUEUE" : "would requeue"}: "${document.title ?? document.id}" v${document.ingestion_version} -> v${nextVersion}`,
    );

    if (!args.apply) {
      continue;
    }

    const { error: updateError } = await supabase
      .from("documents")
      .update({ ingestion_version: nextVersion, status: "queued" })
      .eq("id", document.id)
      .eq("ingestion_version", document.ingestion_version);
    if (updateError) {
      throw new Error(
        `Failed to bump version for ${document.id}: ${updateError.message}`,
      );
    }

    const { error: jobError } = await supabase.from("ingestion_jobs").insert({
      document_id: document.id,
      status: "queued",
      attempt: 0,
      idempotency_key: `${document.sha256}:v${nextVersion}`,
    });
    if (jobError) {
      throw new Error(
        `Failed to queue job for ${document.id}: ${jobError.message}`,
      );
    }
  }

  if (args.apply) {
    console.log(
      `Requeued ${documents.length} documents. Run "npm run ingestion:worker:once" until the queue drains.`,
    );
  } else {
    console.log(
      `Dry run only — ${documents.length} documents would be requeued. Re-run with --apply.`,
    );
  }
}

run().catch((error) => {
  console.error(
    `Requeue failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
