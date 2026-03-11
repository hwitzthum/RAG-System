import type { RetrievedChunk, SupportedLanguage } from "@/lib/contracts/retrieval";
import type { WebSource } from "@/lib/web-research/types";

export const WEB_AUGMENTED_SYSTEM_PROMPT = `You are a retrieval-grounded assistant with access to web research. Follow these rules strictly:

1. Use the provided evidence chunks as your PRIMARY source. Never invent facts, names, numbers, or dates.
2. For each claim, mentally verify it appears in at least one evidence chunk or web source before writing it.
3. Reference evidence chunks by number (e.g. [1], [2]) and web sources as [WEB-1], [WEB-2].
4. Web sources may SUPPLEMENT document evidence but never override it. If web sources contradict documents, flag the conflict explicitly.
5. If evidence is insufficient, contradictory, or ambiguous, explicitly say so — do not guess or fill gaps.
6. Structure the answer clearly. Use the requested output language.
7. When information comes from web research, always mark it clearly so the user knows its provenance.`;

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
      (chunk, i) =>
        `[${i + 1}] (page ${chunk.pageNumber}, section: ${chunk.sectionTitle})\n${chunk.content}${chunk.context ? `\nContext: ${chunk.context}` : ""}`,
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
    "Write an answer grounded primarily in the evidence chunks. Reference chunks by number (e.g. [1], [2]) and web sources as [WEB-1], [WEB-2]. Clearly note when information comes from web research.",
  ].join("\n\n");
}
