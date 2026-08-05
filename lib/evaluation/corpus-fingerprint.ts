import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Fingerprint of the corpus state a golden dataset was generated against:
 * a hash over every ready document's id, chunk count and newest chunk
 * `created_at` (chunk rows are immutable — a re-chunk deletes and re-inserts,
 * so creation time is the freshness signal). Any re-ingest, re-chunk or
 * document add/delete changes it.
 *
 * The benchmark compares the dataset envelope's fingerprint against the live
 * corpus and refuses to run on a mismatch — a re-chunk previously invalidated
 * the golden set silently and read as a retrieval collapse (recall 0.405 on
 * the 2026-08-04 run) that never happened.
 */
export async function computeCorpusFingerprint(
  supabase: SupabaseClient,
): Promise<string> {
  const { data: documents, error: docError } = await supabase
    .from("documents")
    .select("id")
    .eq("status", "ready")
    .order("id", { ascending: true });
  if (docError) {
    throw new Error(`corpus_fingerprint_documents: ${docError.message}`);
  }

  const lines: string[] = [];
  for (const document of documents ?? []) {
    const { count, error: countError } = await supabase
      .from("document_chunks")
      .select("id", { count: "exact", head: true })
      .eq("document_id", document.id);
    if (countError) {
      throw new Error(`corpus_fingerprint_chunks: ${countError.message}`);
    }

    const { data: newest, error: newestError } = await supabase
      .from("document_chunks")
      .select("created_at")
      .eq("document_id", document.id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (newestError) {
      throw new Error(`corpus_fingerprint_created: ${newestError.message}`);
    }

    lines.push(
      `${document.id}:${count ?? 0}:${newest?.[0]?.created_at ?? "none"}`,
    );
  }

  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
