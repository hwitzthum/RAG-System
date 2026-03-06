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
  language?: SupportedLanguage | null;
  limit: number;
  documentIds?: string[];
};

type SearchVectorCandidatesInput = {
  queryEmbedding: number[];
  language?: SupportedLanguage | null;
  limit: number;
  documentIds?: string[];
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

  let baseQuery = supabase
    .from("document_chunks")
    .select("id,document_id,page_number,section_title,content,context,language,documents!inner(status)")
    .eq("documents.status", "ready")
    .textSearch("tsv", textQuery, { config: "simple", type: "plain" })
    .limit(limit);

  if (input.documentIds && input.documentIds.length > 0) {
    baseQuery = baseQuery.in("document_id", input.documentIds);
  }

  const query = input.language ? baseQuery.eq("language", input.language) : baseQuery;

  const { data, error } = await query.returns<
    Array<RetrievalChunkRow & { documents: { status: string } | { status: string }[] | null }>
  >();

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
  const scopedLimit = input.documentIds && input.documentIds.length > 0 ? Math.max(limit * 10, limit + 20) : limit;

  const { data, error } = await supabase.rpc("match_document_chunks", {
    query_embedding: input.queryEmbedding,
    match_count: scopedLimit,
    filter_language: input.language ?? null,
  });

  if (error) {
    throw new Error(`Vector retrieval failed: ${error.message}`);
  }

  let rows = (data ?? []) as MatchChunkRow[];
  if (input.documentIds && input.documentIds.length > 0) {
    const allowedIds = new Set(input.documentIds);
    rows = rows.filter((row) => allowedIds.has(row.document_id));
  }

  return rows.slice(0, limit).map((row) => ({
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
