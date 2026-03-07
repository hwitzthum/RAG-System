import type { RetrievedChunk, SupportedLanguage } from "@/lib/contracts/retrieval";
import type { WebSource } from "@/lib/web-research/types";

export const WEB_AUGMENTED_SYSTEM_PROMPT = `You are a retrieval-grounded assistant with access to web research.
Answer using the provided evidence chunks as your primary source.
You may supplement with web sources when they add valuable context, but clearly distinguish web information.
If evidence is insufficient or ambiguous, explicitly say you do not have enough evidence.
Do not invent facts, names, or numbers not present in the evidence or web sources.
Keep the answer concise, structured, and in the requested output language.`;

function formatWebSource(source: WebSource, index: number): string {
  return [
    `web_source_${index + 1}:`,
    `  title: ${source.title}`,
    `  url: ${source.url}`,
    `  snippet: ${source.snippet}`,
  ].join("\n");
}

export function buildWebAugmentedUserPrompt(input: {
  query: string;
  language: SupportedLanguage;
  chunks: RetrievedChunk[];
  webSources: WebSource[];
}): string {
  const evidenceBlocks = input.chunks
    .map(
      (chunk) =>
        `chunk_id: ${chunk.chunkId}\ndocument_id: ${chunk.documentId}\npage_number: ${chunk.pageNumber}\nsection_title: ${chunk.sectionTitle}\ncontent: ${chunk.content}\ncontext: ${chunk.context}`,
    )
    .join("\n\n---\n\n");

  const webBlocks = input.webSources.map((s, i) => formatWebSource(s, i)).join("\n\n");

  return [
    `User query: ${input.query}`,
    `Output language: ${input.language}`,
    "Evidence chunks:",
    evidenceBlocks || "(none)",
    "",
    "Web research sources:",
    webBlocks || "(none)",
    "",
    "Write an answer grounded primarily in the evidence chunks. Supplement with web sources where helpful, clearly noting when information comes from web research.",
  ].join("\n\n");
}
