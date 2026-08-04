#!/usr/bin/env tsx

/**
 * Generates a golden evaluation dataset from the REAL document corpus.
 *
 * For a sample of chunks across every ready document, an LLM drafts a
 * question (in the chunk's language) plus acceptable answer points grounded
 * in the actual chunk text. Expected document/page/section come from the
 * chunk row itself, so retrieval metrics measure the live system against
 * ground truth that provably exists in the corpus.
 *
 * Outputs:
 *   evaluation/evaluation_queries.generated.json  — machine-readable dataset
 *   evaluation/reports/dataset-review.md          — human review sheet
 *
 * Usage:
 *   npm run eval:dataset:corpus            (dotenv loads .env.local)
 */

import fs from "node:fs";
import path from "node:path";
import { validateEvaluationDataset } from "../../lib/evaluation/dataset";
import type { EvaluationQueryRecord } from "../../lib/evaluation/types";

type ChunkRow = {
  id: string;
  document_id: string;
  chunk_index: number;
  page_number: number;
  section_title: string | null;
  content: string;
  language: "EN" | "DE" | "FR" | "IT" | "ES";
};

type DocumentRow = {
  id: string;
  title: string | null;
};

type GeneratedQuestion = {
  question: string;
  acceptable_answer_points: string[];
};

const MIN_CHUNK_CHARS = 200;
const MAX_SAMPLES_PER_DOC = 10;
const MIN_SAMPLES_PER_DOC = 3;
const LLM_TIMEOUT_MS = 30_000;
const CONCURRENCY = 5;

const GENERATOR_SYSTEM_PROMPT = [
  "You write evaluation questions for a retrieval-augmented QA system.",
  "Given a document excerpt, produce ONE question a real user would plausibly ask that this excerpt answers, plus the key facts a correct answer must contain.",
  "Rules:",
  "- Write the question AND the answer points in the SAME language as the excerpt.",
  "- The question must be answerable from the excerpt alone, and must NOT quote the excerpt's phrasing verbatim — phrase it the way a user who has not read the document would.",
  "- Provide 3 to 5 answer points. Each is one short factual sentence taken from the excerpt's content (facts, names, numbers, steps). Cover ALL the central facts of the excerpt, not just the first one.",
  "- Never invent facts that are not in the excerpt.",
  'Return ONLY a JSON object: {"question": string, "acceptable_answer_points": string[]}.',
].join("\n");

function parseArgs(argv: string[]): { outPath: string; reviewPath: string } {
  let outPath = "evaluation/evaluation_queries.generated.json";
  let reviewPath = "evaluation/reports/dataset-review.md";
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--out") {
      outPath = argv[index + 1] ?? outPath;
      index += 1;
    } else if (argv[index] === "--review") {
      reviewPath = argv[index + 1] ?? reviewPath;
      index += 1;
    }
  }
  return { outPath, reviewPath };
}

/** Evenly spaced sample so questions span the whole document, not just its head. */
function sampleEvenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) {
    return items;
  }
  const sampled: T[] = [];
  const step = items.length / count;
  for (let index = 0; index < count; index += 1) {
    sampled.push(items[Math.floor(index * step)]!);
  }
  return sampled;
}

async function generateQuestionForChunk(
  chunk: ChunkRow,
  documentTitle: string,
  apiKey: string,
  model: string,
): Promise<GeneratedQuestion | null> {
  const excerpt = chunk.content.slice(0, 2_500);
  const userPrompt = [
    `Document title: ${documentTitle}`,
    `Section: ${chunk.section_title ?? "(none)"}`,
    `Language: ${chunk.language}`,
    `Excerpt:\n${excerpt}`,
  ].join("\n\n");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            max_tokens: 500,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: GENERATOR_SYSTEM_PROMPT },
              { role: "user", content: userPrompt },
            ],
          }),
        },
      );

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(
          payload.error?.message ?? `generator_http_${response.status}`,
        );
      }

      const parsed = JSON.parse(
        payload.choices?.[0]?.message?.content ?? "{}",
      ) as Partial<GeneratedQuestion>;

      const question =
        typeof parsed.question === "string" ? parsed.question.trim() : "";
      const points = Array.isArray(parsed.acceptable_answer_points)
        ? parsed.acceptable_answer_points
            .filter((point): point is string => typeof point === "string")
            .map((point) => point.trim())
            .filter((point) => point.length > 0)
        : [];

      if (question.length >= 10 && points.length >= 3) {
        return { question, acceptable_answer_points: points.slice(0, 5) };
      }
      throw new Error("generator_output_incomplete");
    } catch (error) {
      if (attempt === 1) {
        console.warn(
          `Skipping chunk ${chunk.id}: ${error instanceof Error ? error.message : "unknown_error"}`,
        );
        return null;
      }
    }
  }
  return null;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv);
  const { env } = await import("../../lib/config/env");
  const { getSupabaseAdminClient } = await import("../../lib/supabase/admin");

  const apiKey = env.OPENAI_API_KEY;
  const model = env.RAG_EVAL_JUDGE_MODEL;
  const supabase = getSupabaseAdminClient();

  const { data: documents, error: docError } = await supabase
    .from("documents")
    .select("id,title")
    .eq("status", "ready")
    .returns<DocumentRow[]>();
  if (docError) {
    throw new Error(`Failed to load documents: ${docError.message}`);
  }
  if (!documents || documents.length === 0) {
    throw new Error(
      "No ready documents in the corpus. Upload documents first.",
    );
  }

  const records: EvaluationQueryRecord[] = [];
  const reviewSections: string[] = [];

  for (const document of documents) {
    const { data: chunks, error: chunkError } = await supabase
      .from("document_chunks")
      .select(
        "id,document_id,chunk_index,page_number,section_title,content,language",
      )
      .eq("document_id", document.id)
      .order("chunk_index", { ascending: true })
      .returns<ChunkRow[]>();
    if (chunkError) {
      throw new Error(
        `Failed to load chunks for ${document.id}: ${chunkError.message}`,
      );
    }

    const substantive = (chunks ?? []).filter(
      (chunk) => chunk.content.trim().length >= MIN_CHUNK_CHARS,
    );
    if (substantive.length === 0) {
      console.warn(
        `Document ${document.id} has no substantive chunks; skipped.`,
      );
      continue;
    }

    const sampleCount = Math.min(
      MAX_SAMPLES_PER_DOC,
      Math.max(MIN_SAMPLES_PER_DOC, Math.ceil(substantive.length / 6)),
    );
    const sampled = sampleEvenly(substantive, sampleCount);
    const documentTitle = document.title ?? "(untitled)";

    console.log(
      `Generating ${sampled.length} questions for "${documentTitle}" (${substantive.length} chunks)...`,
    );

    const reviewRows: string[] = [];
    for (let start = 0; start < sampled.length; start += CONCURRENCY) {
      const batch = sampled.slice(start, start + CONCURRENCY);
      const generated = await Promise.all(
        batch.map((chunk) =>
          generateQuestionForChunk(chunk, documentTitle, apiKey, model),
        ),
      );

      for (let index = 0; index < batch.length; index += 1) {
        const chunk = batch[index]!;
        const output = generated[index];
        if (!output) {
          continue;
        }

        records.push({
          id: `${chunk.language.toLowerCase()}-${document.id.slice(0, 8)}-${chunk.chunk_index}`,
          language: chunk.language,
          question: output.question,
          expected_document: document.id,
          expected_section: chunk.section_title ?? "",
          expected_pages: [chunk.page_number],
          acceptable_answer_points: output.acceptable_answer_points,
        });

        reviewRows.push(
          [
            `### ${records[records.length - 1]!.id}`,
            ``,
            `- **Question (${chunk.language})**: ${output.question}`,
            `- **Expected**: page ${chunk.page_number}, section "${chunk.section_title ?? ""}"`,
            `- **Answer points**:`,
            ...output.acceptable_answer_points.map((point) => `  - ${point}`),
            `- **Source excerpt**: ${chunk.content.slice(0, 300).replace(/\s+/g, " ")}...`,
            ``,
          ].join("\n"),
        );
      }
    }

    reviewSections.push(
      `## ${documentTitle} (\`${document.id}\`)\n\n${reviewRows.join("\n")}`,
    );
  }

  if (records.length === 0) {
    throw new Error("No evaluation records were generated.");
  }

  // Fails loudly if the generated set is too small or unbalanced.
  const validation = validateEvaluationDataset(records, {
    minTotalQueries: 25,
    minPerLanguage: 5,
  });

  const outPath = path.resolve(args.outPath);
  const reviewPath = path.resolve(args.reviewPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });

  fs.writeFileSync(outPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  const languageSummary = Object.entries(validation.languageCounts)
    .filter(([, count]) => count > 0)
    .map(([language, count]) => `${language}: ${count}`)
    .join(", ");

  fs.writeFileSync(
    reviewPath,
    [
      `# Corpus Golden Dataset — Review Sheet`,
      ``,
      `Generated: ${new Date().toISOString()}`,
      `Records: ${validation.totalQueries} (${languageSummary})`,
      ``,
      `Review each question for: (1) natural phrasing a user would use, (2) answerable from the stated page/section, (3) answer points factually match the source excerpt. Delete or edit records in \`${args.outPath}\` as needed, then promote it to \`evaluation/evaluation_queries.json\`.`,
      ``,
      reviewSections.join("\n\n"),
    ].join("\n"),
    "utf8",
  );

  console.log(
    `Dataset: ${outPath} (${validation.totalQueries} records — ${languageSummary})`,
  );
  console.log(`Review sheet: ${reviewPath}`);
}

run().catch((error) => {
  console.error(
    `Dataset generation failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
