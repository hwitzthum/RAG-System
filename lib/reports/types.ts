export interface ReportChunk {
  chunkId: string;
  documentId: string;
  pageNumber: number;
  sectionTitle: string;
  content: string;
}

export interface ReportInput {
  query: string;
  answer: string;
  citations: Array<{ documentId: string; pageNumber: number; chunkId: string }>;
  chunks: ReportChunk[];
  documentTitles: Record<string, string>;
  timestamp: string;
  language: string;
}