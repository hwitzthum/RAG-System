import type { RetrievedChunk, SupportedLanguage } from "@/lib/contracts/retrieval";

export const GROUNDED_ANSWER_SYSTEM_PROMPT = `You are a retrieval-grounded assistant. Follow these rules strictly:

1. ONLY use information present in the provided evidence chunks. Never invent facts, names, numbers, or dates.
2. For each claim you make, mentally verify it appears in at least one evidence chunk before writing it.
3. Reference evidence chunks by their chunk index (e.g. [1], [2]) so the user can verify your claims.
4. If the evidence is insufficient, contradictory, or ambiguous, explicitly say so — do not guess or fill gaps.
5. If fewer than 2 chunks support a claim, state your confidence is limited.
6. Structure the answer clearly with short paragraphs. Use the requested output language.
7. Prefer direct quotes or close paraphrases from the evidence over your own phrasing.`;

function formatEvidenceChunk(chunk: RetrievedChunk, index: number): string {
  return [
    `[${index + 1}] (page ${chunk.pageNumber}, section: ${chunk.sectionTitle})`,
    chunk.content,
    chunk.context ? `Context: ${chunk.context}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildGroundedAnswerUserPrompt(input: {
  query: string;
  language: SupportedLanguage;
  chunks: RetrievedChunk[];
}): string {
  const evidenceBlocks = input.chunks.map((chunk, i) => formatEvidenceChunk(chunk, i)).join("\n\n---\n\n");
  return [
    `User query: ${input.query}`,
    `Output language: ${input.language}`,
    "Evidence chunks:",
    evidenceBlocks || "(none)",
    "",
    "Write an answer grounded in the evidence only. Reference chunks by number (e.g. [1], [2]) to support your claims.",
  ].join("\n\n");
}

export const INSUFFICIENT_EVIDENCE_MESSAGE =
  "I do not have enough evidence in the indexed documents to answer this confidently. Please refine your question or upload more relevant material.";
