#!/usr/bin/env tsx

/**
 * Generates a golden evaluation dataset from the REAL document corpus.
 *
 * Three slices:
 *   - single_hop: for a sample of chunks across every ready document, an LLM
 *     drafts a question (in the chunk's language) plus acceptable answer
 *     points grounded in the actual chunk text.
 *   - multi_hop: for pairs of chunks from DIFFERENT documents in the same
 *     language, a question that requires synthesizing both excerpts.
 *   - unanswerable: questions about topics provably absent from the corpus —
 *     each candidate ships probe terms that are keyword-checked against every
 *     chunk, and any candidate whose terms appear anywhere is discarded.
 *
 * Every answerable record carries the exact chunk id(s) it was generated
 * from, and the output file is an envelope binding the records to a corpus
 * fingerprint, so the benchmark can refuse to run against a corpus the
 * dataset no longer describes.
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
import type {
  EvaluationDatasetEnvelope,
  EvaluationQueryRecord,
} from "../../lib/evaluation/types";

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

type UnanswerableCandidate = {
  question: string;
  probe_terms: string[];
};

const MIN_CHUNK_CHARS = 200;
const MAX_SAMPLES_PER_DOC = 10;
const MIN_SAMPLES_PER_DOC = 3;
const MULTI_HOP_PAIRS_PER_LANGUAGE = 4;
const UNANSWERABLE_TARGET = 15;
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

const MULTI_HOP_SYSTEM_PROMPT = [
  "You write multi-hop evaluation questions for a retrieval-augmented QA system.",
  "Given TWO excerpts from DIFFERENT documents, produce ONE question that can only be answered correctly by combining information from BOTH excerpts.",
  "Rules:",
  "- Write the question AND the answer points in the SAME language as the excerpts.",
  "- The question must genuinely require both excerpts: a correct answer drawn from only one of them must be incomplete. Comparison, combination, or contrast questions all qualify.",
  "- Provide 3 to 5 answer points covering the facts a correct answer must contain, drawn from BOTH excerpts — at least one point per excerpt.",
  "- Do NOT quote the excerpts' phrasing verbatim; phrase the question the way a user who has not read the documents would.",
  "- Never invent facts that are not in the excerpts.",
  '- If the two excerpts share no meaningful connection and no natural question spans both, return {"feasible": false} instead.',
  'Return ONLY a JSON object: {"feasible": true, "question": string, "acceptable_answer_points": string[]} or {"feasible": false}.',
].join("\n");

const UNANSWERABLE_SYSTEM_PROMPT = [
  "You write UNANSWERABLE evaluation questions for a retrieval-augmented QA system: questions the corpus described below provably cannot answer.",
  "The correct system behaviour on these questions is to abstain. A system that answers them is hallucinating.",
  "Rules:",
  "- Every question must be built around an INVENTED specific entity: a project name, person, programme, partner organisation, report, metric or event that you make up. It must sound at home in this corpus's subject matter, but it must not exist in it.",
  "- Do NOT ask about the corpus's real documents, real projects, real people, or real topics — a question whose subject actually appears in the corpus is a failed candidate. Do NOT simply ask for a detail (budget, author, date, page count) of a real document.",
  "- Write each question in the requested language.",
  '- For each question, provide 2 to 3 "probe_terms": the invented entity names from the question, exactly as spelled there. They will be literally searched against every document; the question only survives when NONE of them appear, so never use real document titles, real names from the outline, years, or generic domain words as probe terms.',
  "- Vary the invented entities across questions; never reuse one.",
  'Return ONLY a JSON object: {"questions": [{"question": string, "probe_terms": string[]}]}.',
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

async function callGenerator(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string,
  model: string,
  maxTokens: number,
): Promise<unknown> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(
      payload.error?.message ?? `generator_http_${response.status}`,
    );
  }

  return JSON.parse(payload.choices?.[0]?.message?.content ?? "{}");
}

function parseAnswerPoints(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw
        .filter((point): point is string => typeof point === "string")
        .map((point) => point.trim())
        .filter((point) => point.length > 0)
    : [];
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
      const parsed = (await callGenerator(
        GENERATOR_SYSTEM_PROMPT,
        userPrompt,
        apiKey,
        model,
        500,
      )) as Partial<GeneratedQuestion>;

      const question =
        typeof parsed.question === "string" ? parsed.question.trim() : "";
      const points = parseAnswerPoints(parsed.acceptable_answer_points);

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

async function generateMultiHopQuestion(
  first: { chunk: ChunkRow; documentTitle: string },
  second: { chunk: ChunkRow; documentTitle: string },
  apiKey: string,
  model: string,
): Promise<GeneratedQuestion | null> {
  const userPrompt = [
    `Language: ${first.chunk.language}`,
    `Excerpt A (from "${first.documentTitle}"):\n${first.chunk.content.slice(0, 2_000)}`,
    `Excerpt B (from "${second.documentTitle}"):\n${second.chunk.content.slice(0, 2_000)}`,
  ].join("\n\n");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const parsed = (await callGenerator(
        MULTI_HOP_SYSTEM_PROMPT,
        userPrompt,
        apiKey,
        model,
        600,
      )) as {
        feasible?: boolean;
        question?: string;
        acceptable_answer_points?: unknown;
      };

      if (parsed.feasible === false) {
        return null;
      }

      const question =
        typeof parsed.question === "string" ? parsed.question.trim() : "";
      const points = parseAnswerPoints(parsed.acceptable_answer_points);

      if (question.length >= 10 && points.length >= 3) {
        return { question, acceptable_answer_points: points.slice(0, 5) };
      }
      throw new Error("generator_output_incomplete");
    } catch (error) {
      if (attempt === 1) {
        console.warn(
          `Skipping multi-hop pair ${first.chunk.id}/${second.chunk.id}: ${error instanceof Error ? error.message : "unknown_error"}`,
        );
        return null;
      }
    }
  }
  return null;
}

async function generateUnanswerableCandidates(
  language: "EN" | "DE",
  count: number,
  corpusOutline: string,
  apiKey: string,
  model: string,
): Promise<UnanswerableCandidate[]> {
  const userPrompt = [
    `Language for the questions: ${language}`,
    `Number of questions: ${count}`,
    `Corpus outline (document titles and section headings):\n${corpusOutline}`,
  ].join("\n\n");

  try {
    const parsed = (await callGenerator(
      UNANSWERABLE_SYSTEM_PROMPT,
      userPrompt,
      apiKey,
      model,
      4_000,
    )) as { questions?: Array<Partial<UnanswerableCandidate>> };

    return (parsed.questions ?? [])
      .map((candidate) => ({
        question:
          typeof candidate.question === "string"
            ? candidate.question.trim()
            : "",
        probe_terms: parseAnswerPoints(candidate.probe_terms),
      }))
      .filter(
        (candidate) =>
          // One probe term is enough: a question built around a single
          // invented entity legitimately has exactly one term to verify.
          candidate.question.length >= 10 && candidate.probe_terms.length >= 1,
      );
  } catch (error) {
    console.warn(
      `Unanswerable generation failed for ${language}: ${error instanceof Error ? error.message : "unknown_error"}`,
    );
    return [];
  }
}

/**
 * A probe term "appears in the corpus" when any chunk contains it,
 * case-insensitively. A candidate survives only when NONE of its probe terms
 * appear — that absence is what makes the question provably unanswerable.
 */
async function probeTermsAbsent(
  supabase: Awaited<
    ReturnType<typeof import("../../lib/supabase/admin").getSupabaseAdminClient>
  >,
  terms: string[],
): Promise<boolean> {
  for (const term of terms) {
    const escaped = term.replace(/[%_]/g, "\\$&");
    const { count, error } = await supabase
      .from("document_chunks")
      .select("id", { count: "exact", head: true })
      .ilike("content", `%${escaped}%`);
    if (error) {
      throw new Error(`probe_term_check_failed: ${error.message}`);
    }
    if ((count ?? 0) > 0) {
      return false;
    }
  }
  return true;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv);
  const { env } = await import("../../lib/config/env");
  const { getSupabaseAdminClient } = await import("../../lib/supabase/admin");
  const { computeCorpusFingerprint } =
    await import("../../lib/evaluation/corpus-fingerprint");

  const apiKey = env.OPENAI_API_KEY;
  const model = env.RAG_DATASET_GENERATOR_MODEL;
  const supabase = getSupabaseAdminClient();

  // Fingerprint FIRST: if an ingestion worker changes the corpus while
  // questions are being generated, the closing fingerprint comparison below
  // catches it and the run fails rather than emitting a mislabelled dataset.
  const corpusFingerprint = await computeCorpusFingerprint(supabase);

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
  const substantiveByDocument = new Map<string, ChunkRow[]>();
  const documentTitles = new Map<string, string>();

  // ---- Slice 1: single_hop --------------------------------------------------

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
    substantiveByDocument.set(document.id, substantive);
    documentTitles.set(document.id, document.title ?? "(untitled)");

    const sampleCount = Math.min(
      MAX_SAMPLES_PER_DOC,
      Math.max(MIN_SAMPLES_PER_DOC, Math.ceil(substantive.length / 6)),
    );
    const sampled = sampleEvenly(substantive, sampleCount);
    const documentTitle = document.title ?? "(untitled)";

    console.log(
      `Generating ${sampled.length} single-hop questions for "${documentTitle}" (${substantive.length} chunks)...`,
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
          question_type: "single_hop",
          expected_chunk_ids: [chunk.id],
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
            `- **Expected**: chunk \`${chunk.id}\`, page ${chunk.page_number}, section "${chunk.section_title ?? ""}"`,
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

  // ---- Slice 2: multi_hop ---------------------------------------------------

  const multiHopReviewRows: string[] = [];
  for (const language of ["EN", "DE"] as const) {
    const documentsInLanguage = [...substantiveByDocument.entries()]
      .map(([documentId, chunks]) => ({
        documentId,
        chunks: chunks.filter((chunk) => chunk.language === language),
      }))
      .filter((entry) => entry.chunks.length > 0);

    if (documentsInLanguage.length < 2) {
      console.warn(
        `Multi-hop skipped for ${language}: needs chunks in >= 2 documents.`,
      );
      continue;
    }

    // Over-generate candidate pairs: two arbitrary documents often share no
    // meaningful connection, and the LLM is told to refuse those pairs
    // (feasible: false), so attempts exceed the target and the loop keeps
    // the first MULTI_HOP_PAIRS_PER_LANGUAGE that succeed.
    const attemptCount = MULTI_HOP_PAIRS_PER_LANGUAGE * 3;
    // Round-robin document pairs; chunks sampled from different offsets so
    // repeated pairs of the same two documents still cover fresh content.
    const pairs: Array<{ first: ChunkRow; second: ChunkRow }> = [];
    for (let index = 0; index < attemptCount; index += 1) {
      const firstDoc = documentsInLanguage[index % documentsInLanguage.length]!;
      const secondDoc =
        documentsInLanguage[(index + 1) % documentsInLanguage.length]!;
      if (firstDoc.documentId === secondDoc.documentId) {
        break;
      }
      const firstChunk =
        firstDoc.chunks[
          Math.floor(
            ((index / attemptCount) * firstDoc.chunks.length) %
              firstDoc.chunks.length,
          )
        ]!;
      const secondChunk =
        secondDoc.chunks[
          Math.floor(
            (((index + 0.5) / attemptCount) * secondDoc.chunks.length) %
              secondDoc.chunks.length,
          )
        ]!;
      pairs.push({ first: firstChunk, second: secondChunk });
    }

    console.log(
      `Generating ${pairs.length} multi-hop questions for ${language}...`,
    );

    const generated = await Promise.all(
      pairs.map((pair) =>
        generateMultiHopQuestion(
          {
            chunk: pair.first,
            documentTitle: documentTitles.get(pair.first.document_id) ?? "",
          },
          {
            chunk: pair.second,
            documentTitle: documentTitles.get(pair.second.document_id) ?? "",
          },
          apiKey,
          model,
        ),
      ),
    );

    let keptPairs = 0;
    for (let index = 0; index < pairs.length; index += 1) {
      const output = generated[index];
      const pair = pairs[index]!;
      if (!output || keptPairs >= MULTI_HOP_PAIRS_PER_LANGUAGE) {
        continue;
      }
      keptPairs += 1;

      const record: EvaluationQueryRecord = {
        id: `mh-${language.toLowerCase()}-${pair.first.document_id.slice(0, 8)}-${pair.first.chunk_index}-${pair.second.document_id.slice(0, 8)}-${pair.second.chunk_index}`,
        language,
        question: output.question,
        question_type: "multi_hop",
        expected_chunk_ids: [pair.first.id, pair.second.id],
        expected_document: pair.first.document_id,
        expected_section: pair.first.section_title ?? "",
        expected_pages: [pair.first.page_number, pair.second.page_number],
        acceptable_answer_points: output.acceptable_answer_points,
      };
      records.push(record);

      multiHopReviewRows.push(
        [
          `### ${record.id}`,
          ``,
          `- **Question (${language})**: ${output.question}`,
          `- **Evidence A**: chunk \`${pair.first.id}\` — "${documentTitles.get(pair.first.document_id)}", page ${pair.first.page_number}`,
          `- **Evidence B**: chunk \`${pair.second.id}\` — "${documentTitles.get(pair.second.document_id)}", page ${pair.second.page_number}`,
          `- **Answer points**:`,
          ...output.acceptable_answer_points.map((point) => `  - ${point}`),
          ``,
        ].join("\n"),
      );
    }
  }

  if (multiHopReviewRows.length > 0) {
    reviewSections.push(
      `## Multi-hop questions\n\n${multiHopReviewRows.join("\n")}`,
    );
  }

  // ---- Slice 3: unanswerable ------------------------------------------------

  const corpusOutline = [...substantiveByDocument.entries()]
    .map(([documentId, chunks]) => {
      const sections = [
        ...new Set(
          chunks
            .map((chunk) => chunk.section_title?.trim())
            .filter((title): title is string => Boolean(title)),
        ),
      ].slice(0, 12);
      return `- ${documentTitles.get(documentId)}: ${sections.join("; ")}`;
    })
    .join("\n");

  const languageShares: Array<{ language: "EN" | "DE"; target: number }> = [
    { language: "EN", target: Math.ceil(UNANSWERABLE_TARGET / 2) },
    { language: "DE", target: Math.floor(UNANSWERABLE_TARGET / 2) },
  ];

  const unanswerableReviewRows: string[] = [];
  const UNANSWERABLE_ROUNDS = 3;
  for (const share of languageShares) {
    let kept = 0;
    // Rounds of over-generation: keyword verification discards candidates
    // whose probe terms turn out to exist in the corpus, so a single batch
    // can fall short of the target.
    for (
      let round = 0;
      round < UNANSWERABLE_ROUNDS && kept < share.target;
      round += 1
    ) {
      const candidates = await generateUnanswerableCandidates(
        share.language,
        (share.target - kept) * 2,
        corpusOutline,
        apiKey,
        model,
      );

      console.log(
        `Verifying ${candidates.length} unanswerable candidates for ${share.language} (round ${round + 1})...`,
      );

      for (const candidate of candidates) {
        if (kept >= share.target) {
          break;
        }
        const absent = await probeTermsAbsent(supabase, candidate.probe_terms);
        if (!absent) {
          console.warn(
            `Discarding unanswerable candidate (probe term found in corpus): ${candidate.question}`,
          );
          continue;
        }

        kept += 1;
        const record: EvaluationQueryRecord = {
          id: `ua-${share.language.toLowerCase()}-${kept}`,
          language: share.language,
          question: candidate.question,
          question_type: "unanswerable",
          expected_chunk_ids: [],
          expected_document: "",
          expected_section: "",
          expected_pages: [],
          acceptable_answer_points: [],
        };
        records.push(record);

        unanswerableReviewRows.push(
          [
            `### ${record.id}`,
            ``,
            `- **Question (${share.language})**: ${candidate.question}`,
            `- **Probe terms (verified absent)**: ${candidate.probe_terms.join(", ")}`,
            `- **Correct behaviour**: abstain (insufficient evidence)`,
            ``,
          ].join("\n"),
        );
      }
    }

    if (kept < share.target) {
      console.warn(
        `Only ${kept}/${share.target} unanswerable questions survived verification for ${share.language}.`,
      );
    }
  }

  if (unanswerableReviewRows.length > 0) {
    reviewSections.push(
      `## Unanswerable questions (correct behaviour: abstention)\n\n${unanswerableReviewRows.join("\n")}`,
    );
  }

  // ---- Envelope + validation ------------------------------------------------

  if (records.length === 0) {
    throw new Error("No evaluation records were generated.");
  }

  // The corpus must not have changed under us while questions were generated
  // (e.g. by a concurrently running ingestion worker) — otherwise the recorded
  // fingerprint would mislabel the dataset.
  const closingFingerprint = await computeCorpusFingerprint(supabase);
  if (closingFingerprint !== corpusFingerprint) {
    throw new Error(
      "Corpus changed during dataset generation (fingerprint moved). Re-run once ingestion is idle.",
    );
  }

  const envelope: EvaluationDatasetEnvelope = {
    corpusFingerprint,
    generatedAt: new Date().toISOString(),
    generatorModel: model,
    records,
  };

  // Fails loudly if the generated set is too small or unbalanced.
  const validation = validateEvaluationDataset(envelope, {
    minTotalQueries: 25,
    minPerLanguage: 5,
  });

  const outPath = path.resolve(args.outPath);
  const reviewPath = path.resolve(args.reviewPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });

  fs.writeFileSync(outPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");

  const languageSummary = Object.entries(validation.languageCounts)
    .filter(([, count]) => count > 0)
    .map(([language, count]) => `${language}: ${count}`)
    .join(", ");
  const typeCounts = records.reduce<Record<string, number>>((acc, record) => {
    acc[record.question_type] = (acc[record.question_type] ?? 0) + 1;
    return acc;
  }, {});
  const typeSummary = Object.entries(typeCounts)
    .map(([type, count]) => `${type}: ${count}`)
    .join(", ");

  fs.writeFileSync(
    reviewPath,
    [
      `# Corpus Golden Dataset — Review Sheet`,
      ``,
      `Generated: ${envelope.generatedAt}`,
      `Corpus fingerprint: \`${corpusFingerprint}\``,
      `Records: ${validation.totalQueries} (answerable by language — ${languageSummary}; by type — ${typeSummary})`,
      ``,
      `Review each question for: (1) natural phrasing a user would use, (2) answerable from the stated chunk(s) — or provably NOT answerable for the unanswerable slice, (3) answer points factually match the source excerpt(s). Delete or edit records in \`${args.outPath}\` as needed.`,
      ``,
      reviewSections.join("\n\n"),
    ].join("\n"),
    "utf8",
  );

  console.log(
    `Dataset: ${outPath} (${validation.totalQueries} records — ${languageSummary}; ${typeSummary})`,
  );
  console.log(`Corpus fingerprint: ${corpusFingerprint}`);
  console.log(`Review sheet: ${reviewPath}`);
}

run().catch((error) => {
  console.error(
    `Dataset generation failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
