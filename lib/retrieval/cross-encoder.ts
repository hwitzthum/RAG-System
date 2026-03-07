import type { RetrievedChunk } from "@/lib/contracts/retrieval";
import { getDefaultProviders } from "@/lib/providers/defaults";

export type CrossEncoderInput = {
  query: string;
  chunks: RetrievedChunk[];
  model: string;
  topK: number;
};

type ScoredPair = {
  index: number;
  score: number;
};

export async function crossEncoderRerank(input: CrossEncoderInput): Promise<RetrievedChunk[]> {
  if (input.chunks.length === 0) {
    return [];
  }

  const llm = getDefaultProviders().llm;

  const pairs = input.chunks.map((chunk, index) => ({
    index,
    text: `${chunk.sectionTitle}\n${chunk.content}`.slice(0, 800),
  }));

  const prompt = [
    "Rate the relevance of each passage to the query on a scale of 0.0 to 1.0.",
    "Return ONLY a JSON array of numbers, one score per passage, in the same order.",
    "",
    `Query: ${input.query}`,
    "",
    ...pairs.map((p, i) => `Passage ${i + 1}:\n${p.text}`),
  ].join("\n");

  const raw = await llm.generateAnswer({
    systemPrompt: "You are a relevance scorer. Output only valid JSON.",
    userPrompt: prompt,
    language: "EN",
    maxOutputTokens: Math.max(100, input.chunks.length * 8),
  });

  let scores: number[];
  try {
    const jsonMatch = raw.match(/\[[\s\S]*?\]/);
    scores = jsonMatch ? (JSON.parse(jsonMatch[0]) as number[]) : [];
  } catch {
    return input.chunks.slice(0, input.topK);
  }

  if (scores.length !== input.chunks.length) {
    return input.chunks.slice(0, input.topK);
  }

  const scored: ScoredPair[] = scores.map((score, index) => ({
    index,
    score: typeof score === "number" && Number.isFinite(score) ? score : 0,
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, input.topK).map((s) => ({
    ...input.chunks[s.index],
    rerankScore: s.score,
  }));
}
