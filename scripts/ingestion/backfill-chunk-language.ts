/**
 * Recomputes `document_chunks.language` for already-ingested chunks.
 *
 * Chunk languages were assigned by a detector that resolved both "no evidence"
 * and "ambiguous evidence" to whichever language happened to be declared first
 * in its table. That mislabelled bare headings ("COORDINATION & CAPACITY") as
 * German and unmistakably German text as French. The detector is fixed in
 * lib/retrieval/language.ts, but existing rows keep their old labels until they
 * are recomputed — and the label decides which stemmer builds the row's `tsv`,
 * so a wrong label costs keyword recall.
 *
 * Re-ingestion is not required: embeddings are built from `context` + `content`
 * and never see the language label, so nothing needs re-embedding. Writing
 * `language` re-fires `document_chunks_set_tsv`, which rebuilds `tsv` with the
 * right configuration.
 *
 * Dry run by default, mirroring scripts/ingestion/reconcile-state.ts:
 *   npm run ingestion:backfill-language
 *   npm run ingestion:backfill-language:apply
 */
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { detectLanguageWithConfidence } from "@/lib/retrieval/language";
import type { SupportedLanguage } from "@/lib/contracts/retrieval";

type ChunkRow = {
  id: string;
  document_id: string;
  section_title: string | null;
  content: string;
  language: SupportedLanguage;
};

type DocumentRow = {
  id: string;
  title: string | null;
  language: SupportedLanguage | null;
};

const APPLY = process.argv.includes("--apply");

function resolveDocumentFallback(
  chunks: ChunkRow[],
  documentLanguage: SupportedLanguage | null,
): SupportedLanguage {
  if (documentLanguage) {
    return documentLanguage;
  }

  const counts = new Map<SupportedLanguage, number>();
  for (const chunk of chunks) {
    const detection = detectLanguageWithConfidence(
      `${chunk.section_title ?? ""} ${chunk.content}`,
    );
    if (detection.confident) {
      counts.set(detection.language, (counts.get(detection.language) ?? 0) + 1);
    }
  }

  let best: SupportedLanguage = "EN";
  let bestCount = 0;
  for (const [language, count] of counts.entries()) {
    if (count > bestCount) {
      bestCount = count;
      best = language;
    }
  }

  return best;
}

async function main(): Promise<void> {
  const supabase = getSupabaseAdminClient();

  const { data: documents, error: documentsError } = await supabase
    .from("documents")
    .select("id, title, language")
    .returns<DocumentRow[]>();

  if (documentsError) {
    throw new Error(`Failed to load documents: ${documentsError.message}`);
  }

  const { data: chunks, error: chunksError } = await supabase
    .from("document_chunks")
    .select("id, document_id, section_title, content, language")
    .returns<ChunkRow[]>();

  if (chunksError) {
    throw new Error(`Failed to load chunks: ${chunksError.message}`);
  }

  const byDocument = new Map<string, ChunkRow[]>();
  for (const chunk of chunks ?? []) {
    const group = byDocument.get(chunk.document_id) ?? [];
    group.push(chunk);
    byDocument.set(chunk.document_id, group);
  }

  const changes: Array<{
    id: string;
    title: string;
    from: SupportedLanguage;
    to: SupportedLanguage;
    reason: "detected" | "inherited";
    preview: string;
  }> = [];

  for (const document of documents ?? []) {
    const documentChunks = byDocument.get(document.id) ?? [];
    if (documentChunks.length === 0) {
      continue;
    }

    const fallback = resolveDocumentFallback(documentChunks, document.language);

    for (const chunk of documentChunks) {
      const detection = detectLanguageWithConfidence(
        `${chunk.section_title ?? ""} ${chunk.content}`,
      );
      const resolved = detection.confident ? detection.language : fallback;

      if (resolved !== chunk.language) {
        changes.push({
          id: chunk.id,
          title: document.title ?? document.id,
          from: chunk.language,
          to: resolved,
          reason: detection.confident ? "detected" : "inherited",
          preview: chunk.content.replace(/\s+/g, " ").slice(0, 70),
        });
      }
    }
  }

  console.log(
    `Scanned ${chunks?.length ?? 0} chunks across ${documents?.length ?? 0} documents.`,
  );
  console.log(`${changes.length} chunk(s) would change language.\n`);

  for (const change of changes) {
    console.log(
      `  ${change.from} -> ${change.to}  [${change.reason}]  ${change.title.slice(0, 38)}\n` +
        `      "${change.preview}"`,
    );
  }

  if (changes.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write these changes.");
    return;
  }

  let updated = 0;
  for (const change of changes) {
    const { error } = await supabase
      .from("document_chunks")
      .update({ language: change.to })
      .eq("id", change.id);

    if (error) {
      throw new Error(`Failed to update chunk ${change.id}: ${error.message}`);
    }
    updated += 1;
  }

  console.log(
    `\nUpdated ${updated} chunk(s). tsv was rebuilt by the update trigger.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
