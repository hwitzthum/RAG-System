import type { RetrievedChunk, SupportedLanguage } from "@/lib/contracts/retrieval";

export const GROUNDED_ANSWER_SYSTEM_PROMPT = `You are a retrieval-grounded assistant.
Answer strictly using the provided evidence chunks.
If evidence is insufficient or ambiguous, explicitly say you do not have enough evidence.
Do not invent facts, names, or numbers not present in the evidence.
Keep the answer concise, structured, and in the requested output language.`;

function formatEvidenceChunk(chunk: RetrievedChunk): string {
  return [
    `chunk_id: ${chunk.chunkId}`,
    `document_id: ${chunk.documentId}`,
    `page_number: ${chunk.pageNumber}`,
    `section_title: ${chunk.sectionTitle}`,
    `content: ${chunk.content}`,
    `context: ${chunk.context}`,
  ].join("\n");
}

export function buildGroundedAnswerUserPrompt(input: {
  query: string;
  language: SupportedLanguage;
  chunks: RetrievedChunk[];
}): string {
  const evidenceBlocks = input.chunks.map((chunk) => formatEvidenceChunk(chunk)).join("\n\n---\n\n");
  return [
    `User query: ${input.query}`,
    `Output language: ${input.language}`,
    "Evidence chunks:",
    evidenceBlocks || "(none)",
    "Write an answer grounded in the evidence only.",
  ].join("\n\n");
}

export const INSUFFICIENT_EVIDENCE_MESSAGE =
  "I do not have enough evidence in the indexed documents to answer this confidently. Please refine your question or upload more relevant material.";
