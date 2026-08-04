import type {
  RetrievedChunk,
  SupportedLanguage,
} from "@/lib/contracts/retrieval";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

type RetrievalChunkRow = {
  id: string;
  document_id: string;
  chunk_index: number;
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

type KeywordChunkRow = Omit<MatchChunkRow, "similarity"> & {
  rank: number;
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

function buildRetrievedChunk(
  row: Pick<
    RetrievalChunkRow,
    | "id"
    | "document_id"
    | "page_number"
    | "section_title"
    | "content"
    | "context"
    | "language"
  >,
  source: RetrievedChunk["source"],
  retrievalScore: number,
): RetrievedChunk {
  return {
    chunkId: row.id,
    documentId: row.document_id,
    pageNumber: row.page_number,
    sectionTitle: normalizeSectionTitle(row.section_title),
    content: row.content,
    context: row.context,
    language: row.language,
    source,
    retrievalScore,
  };
}

function scoreTextQuality(value: string): number {
  if (!value.trim()) {
    return 0;
  }

  const normalized = value.normalize("NFKC");
  const letters = [...normalized].filter((char) => /\p{L}/u.test(char)).length;
  const printable = [...normalized].filter((char) =>
    /[\p{L}\p{N}\p{P}\p{Zs}]/u.test(char),
  ).length;
  const weirdSymbols = [...normalized].filter((char) =>
    /[^\p{L}\p{N}\p{P}\p{Zs}]/u.test(char),
  ).length;

  const letterRatio = letters / normalized.length;
  const printableRatio = printable / normalized.length;
  const weirdRatio = weirdSymbols / normalized.length;

  return letterRatio * 0.55 + printableRatio * 0.35 + (1 - weirdRatio) * 0.1;
}

function hasLowReadability(value: string): boolean {
  if (!value.trim()) {
    return true;
  }

  const normalized = value.normalize("NFKC");
  const suspiciousChars = [...normalized].filter(
    (char) => !/[\p{L}\p{N}\p{Zs}.,;:!?()"'%/&+\-–—§@#*[\]€$]/u.test(char),
  ).length;
  const suspiciousRatio = suspiciousChars / normalized.length;
  const wordCount = normalized
    .split(/\s+/)
    .filter((token) => token.length > 1).length;

  return (
    suspiciousRatio > 0.12 || scoreTextQuality(value) < 0.58 || wordCount < 4
  );
}

function buildOverviewChunk(
  row: RetrievalChunkRow,
  retrievalScore: number,
): RetrievedChunk {
  const contentQuality = scoreTextQuality(row.content);
  const contextQuality = scoreTextQuality(row.context);
  const useContextAsContent =
    hasLowReadability(row.content) && contextQuality >= contentQuality;
  const content = useContextAsContent ? row.context : row.content;

  return {
    ...buildRetrievedChunk(
      {
        ...row,
        content,
        context: row.context,
      },
      "hybrid",
      retrievalScore,
    ),
    // Overview queries are an explicit user request to summarise one scoped
    // document, so the evidence gate passes by design. The gate fields are set
    // explicitly rather than left to resolveRelevance's retrievalScore
    // fallback, which made the bypass an accident of the fallback chain
    // instead of a decision.
    rerankScore: retrievalScore,
    relevanceScore: retrievalScore,
    scoreScale: "heuristic" as const,
  };
}

function selectRepresentativeRows(
  rows: RetrievalChunkRow[],
  limit: number,
): RetrievalChunkRow[] {
  const qualityFiltered = rows.filter(
    (row) => !hasLowReadability(row.content) || !hasLowReadability(row.context),
  );
  const candidateRows =
    qualityFiltered.length >= Math.min(limit, 3) ? qualityFiltered : rows;

  if (candidateRows.length <= limit) {
    return candidateRows;
  }

  const selectedIndexes = new Set<number>();
  const anchorCount = Math.min(2, candidateRows.length, limit);

  for (let index = 0; index < anchorCount; index += 1) {
    selectedIndexes.add(index);
  }

  while (selectedIndexes.size < limit) {
    const ratio =
      (selectedIndexes.size - anchorCount + 1) /
      Math.max(1, limit - anchorCount);
    const rowIndex = Math.round(ratio * (candidateRows.length - 1));
    selectedIndexes.add(
      Math.min(candidateRows.length - 1, Math.max(anchorCount, rowIndex)),
    );
  }

  return [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => candidateRows[index]!)
    .slice(0, limit);
}

/**
 * Ranked keyword retrieval via the `search_document_chunks_keyword` RPC.
 *
 * This previously issued a PostgREST `.textSearch(...).limit(n)` with no
 * `ts_rank` and no `ORDER BY`, so Postgres returned rows in an arbitrary order
 * and the client scored them without ever re-sorting. Because
 * `reciprocalRankFusion` derives each candidate's rank from its position in the
 * array, the keyword branch was feeding effectively random ranks into the
 * fusion. The RPC now ranks with `ts_rank_cd` server-side against a tsvector
 * that carries both exact and stemmed tokens.
 *
 * Language is deliberately not a filter — see `searchVectorCandidates`.
 */
export async function searchKeywordCandidates(
  input: SearchKeywordCandidatesInput,
): Promise<RetrievedChunk[]> {
  if (input.tokens.length === 0) {
    return [];
  }

  const supabase = getSupabaseAdminClient();
  const limit = Math.max(1, input.limit);

  const { data, error } = await supabase.rpc("search_document_chunks_keyword", {
    query_text: input.normalizedQuery,
    match_count: limit,
    filter_document_ids:
      input.documentIds && input.documentIds.length > 0
        ? input.documentIds
        : null,
  });

  if (error) {
    // Degrade to vector-only rather than failing the request. The RPC ships in
    // a migration while the app ships via Vercel, so there is a window on each
    // deploy where the function may not exist yet; losing half the hybrid for a
    // few minutes beats returning a 500 for every query. The degradation is
    // visible — `retrievalTrace.candidateCounts.keyword` goes to zero.
    console.warn("keyword_retrieval_failed", error.message);
    return [];
  }

  const rows = (data ?? []) as KeywordChunkRow[];

  return rows.map((row) =>
    buildRetrievedChunk(
      {
        id: row.chunk_id,
        document_id: row.document_id,
        page_number: row.page_number,
        section_title: row.section_title,
        content: row.content,
        context: row.context,
        language: row.language,
      },
      "keyword",
      row.rank,
    ),
  );
}

/**
 * Dense retrieval. `filter_language` is intentionally always null.
 *
 * The RPC still accepts the parameter (older migrations granted that exact
 * signature), but partitioning the search by language was actively harmful:
 * `text-embedding-3-large` is multilingual, so the filter discarded recall for
 * no gain, and `detectQueryLanguage` resolves short non-English queries to "EN"
 * by falling through a scoreless tie — which silently removed the entire
 * German half of the corpus from consideration. Language now contributes as a
 * ranking signal in `lib/retrieval/reranker.ts` instead, where guessing wrong
 * costs a small nudge rather than most of the index.
 */
export async function searchVectorCandidates(
  input: SearchVectorCandidatesInput,
): Promise<RetrievedChunk[]> {
  const supabase = getSupabaseAdminClient();
  const limit = Math.max(1, input.limit);

  const { data, error } = await supabase.rpc("match_document_chunks", {
    query_embedding: input.queryEmbedding,
    match_count: limit,
    filter_language: null,
    filter_document_ids:
      input.documentIds && input.documentIds.length > 0
        ? input.documentIds
        : null,
  });

  if (error) {
    throw new Error(`Vector retrieval failed: ${error.message}`);
  }

  const rows = (data ?? []) as MatchChunkRow[];

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

export async function loadDocumentOverviewCandidates(input: {
  documentId: string;
  limit: number;
}): Promise<RetrievedChunk[]> {
  const supabase = getSupabaseAdminClient();
  const limit = Math.max(1, input.limit);

  const { data, error } = await supabase
    .from("document_chunks")
    .select(
      "id,document_id,chunk_index,page_number,section_title,content,context,language,documents!inner(status)",
    )
    .eq("documents.status", "ready")
    .eq("document_id", input.documentId)
    .order("chunk_index", { ascending: true })
    .returns<
      Array<
        RetrievalChunkRow & {
          documents: { status: string } | { status: string }[] | null;
        }
      >
    >();

  if (error) {
    throw new Error(`Document overview retrieval failed: ${error.message}`);
  }

  return selectRepresentativeRows(data ?? [], limit).map((row, index) =>
    buildOverviewChunk(row, Math.max(0.9, 1 - index * 0.01)),
  );
}
