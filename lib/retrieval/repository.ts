import type { RetrievedChunk, SupportedLanguage } from "@/lib/contracts/retrieval";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

type RetrievalChunkRow = {
  id: string;
  document_id: string;
  page_number: number;
  section_title: string | null;
  content: string;
  context: string;
  language: SupportedLanguage;
};

type MatchChunkRow = {
  chunk_id: string;
  document_id: string;
  page_number: number;
  section_title: string | null;
  content: string;
  context: string;
  language: SupportedLanguage;
  similarity: number;
};

type SearchKeywordCandidatesInput = {
  normalizedQuery: string;
  tokens: string[];
  language: SupportedLanguage;
  limit: number;
};

type SearchVectorCandidatesInput = {
  queryEmbedding: number[];
  language: SupportedLanguage;
  limit: number;
};

function normalizeSectionTitle(sectionTitle: string | null): string {
  return sectionTitle?.trim() || "Untitled Section";
}

function scoreKeywordRow(tokens: string[], row: RetrievalChunkRow): number {
  if (tokens.length === 0) {
    return 0;
  }

  const searchable = `${row.section_title ?? ""} ${row.context} ${row.content}`.toLowerCase();
  let matches = 0;
  for (const token of tokens) {
    if (searchable.includes(token)) {
      matches += 1;
    }
  }

  return matches / tokens.length;
}

export async function searchKeywordCandidates(input: SearchKeywordCandidatesInput): Promise<RetrievedChunk[]> {
  if (input.tokens.length === 0) {
    return [];
  }

  const supabase = getSupabaseAdminClient();
  const textQuery = input.tokens.join(" ");
  const limit = Math.max(1, input.limit);

  const { data, error } = await supabase
    .from("document_chunks")
    .select("id,document_id,page_number,section_title,content,context,language,documents!inner(status)")
    .eq("documents.status", "ready")
    .eq("language", input.language)
    .textSearch("tsv", textQuery, { config: "simple", type: "plain" })
    .limit(limit)
    .returns<Array<RetrievalChunkRow & { documents: { status: string } | { status: string }[] | null }>>();

  if (error) {
    throw new Error(`Keyword retrieval failed: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    chunkId: row.id,
    documentId: row.document_id,
    pageNumber: row.page_number,
    sectionTitle: normalizeSectionTitle(row.section_title),
    content: row.content,
    context: row.context,
    language: row.language,
    source: "keyword",
    retrievalScore: scoreKeywordRow(input.tokens, row),
  }));
}

export async function searchVectorCandidates(input: SearchVectorCandidatesInput): Promise<RetrievedChunk[]> {
  const supabase = getSupabaseAdminClient();
  const limit = Math.max(1, input.limit);

  const { data, error } = await supabase.rpc("match_document_chunks", {
    query_embedding: input.queryEmbedding,
    match_count: limit,
    filter_language: input.language,
  });

  if (error) {
    throw new Error(`Vector retrieval failed: ${error.message}`);
  }

  const rows = (data ?? []) as MatchChunkRow[];

  return rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    pageNumber: row.page_number,
    sectionTitle: normalizeSectionTitle(row.section_title),
    content: row.content,
    context: row.context,
    language: row.language,
    source: "vector",
    retrievalScore: row.similarity,
    vectorScore: row.similarity,
  }));
}
