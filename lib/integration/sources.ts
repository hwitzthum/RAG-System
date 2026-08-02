// Turning citations into something a reader recognises (dashboard F2.4).
//
// The query pipeline cites `{documentId, pageNumber, chunkId}` — exact, and
// unreadable. A person needs the document's name and the pages it was found on,
// so this resolves the ids and folds repeated hits on one document into a single
// line with its page numbers.

import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export type { AnswerSource } from "@/lib/integration/answer-markdown";

type AnswerSourceShape = {
  documentId: string;
  title: string;
  pages: number[];
};

type Citation = { documentId: string; pageNumber: number; chunkId: string };

export async function resolveSources(
  citations: Citation[],
): Promise<AnswerSourceShape[]> {
  if (citations.length === 0) return [];

  const byDocument = new Map<string, Set<number>>();
  for (const citation of citations) {
    const pages = byDocument.get(citation.documentId) ?? new Set<number>();
    pages.add(citation.pageNumber);
    byDocument.set(citation.documentId, pages);
  }

  const ids = [...byDocument.keys()];
  const supabase = getSupabaseAdminClient();
  const { data } = await supabase
    .from("documents")
    .select("id,title")
    .in("id", ids);

  const titles = new Map<string, string>(
    (data ?? []).map((row: { id: string; title: string | null }) => [
      row.id,
      row.title ?? "Unbenanntes Dokument",
    ]),
  );

  return ids.map((documentId) => ({
    documentId,
    // A document that has since been deleted still deserves an honest line
    // rather than a blank one — the answer was drawn from it.
    title: titles.get(documentId) ?? "Nicht mehr vorhandenes Dokument",
    pages: [...(byDocument.get(documentId) ?? [])].sort((a, b) => a - b),
  }));
}
