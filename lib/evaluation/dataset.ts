import { z } from "zod";
import type { SupportedLanguage } from "@/lib/contracts/retrieval";
import {
  EVALUATION_LANGUAGES,
  EVALUATION_QUESTION_TYPES,
  type DatasetValidationOptions,
  type DatasetValidationResult,
  type EvaluationQueryRecord,
} from "@/lib/evaluation/types";

const evaluationQuerySchema = z
  .object({
    id: z.string().min(1),
    language: z.enum(EVALUATION_LANGUAGES),
    question: z.string().min(1),
    question_type: z.enum(EVALUATION_QUESTION_TYPES),
    expected_chunk_ids: z.array(z.string().min(1)),
    expected_document: z.string(),
    expected_section: z.string(),
    expected_pages: z.array(z.number().int().positive()),
    acceptable_answer_points: z.array(z.string().min(1)),
  })
  .superRefine((record, context) => {
    // An unanswerable question has no gold evidence by definition; every
    // other type must carry exact chunk-id ground truth plus answer points.
    if (record.question_type === "unanswerable") {
      if (record.expected_chunk_ids.length > 0) {
        context.addIssue({
          code: "custom",
          message: "unanswerable records must not carry expected_chunk_ids",
        });
      }
      return;
    }

    if (record.expected_chunk_ids.length === 0) {
      context.addIssue({
        code: "custom",
        message: "answerable records require at least one expected chunk id",
      });
    }
    if (record.expected_document.length === 0) {
      context.addIssue({
        code: "custom",
        message: "answerable records require expected_document",
      });
    }
    if (record.expected_pages.length === 0) {
      context.addIssue({
        code: "custom",
        message: "answerable records require expected_pages",
      });
    }
    if (record.acceptable_answer_points.length === 0) {
      context.addIssue({
        code: "custom",
        message: "answerable records require acceptable_answer_points",
      });
    }
  });

const evaluationDatasetSchema = z.object({
  corpusFingerprint: z.string().min(1),
  generatedAt: z.string().min(1),
  generatorModel: z.string().min(1),
  records: z.array(evaluationQuerySchema),
});

function emptyLanguageCounts(): Record<SupportedLanguage, number> {
  return {
    EN: 0,
    DE: 0,
    FR: 0,
    IT: 0,
    ES: 0,
  };
}

export function validateEvaluationDataset(
  rawDataset: unknown,
  options: Partial<DatasetValidationOptions> = {},
): DatasetValidationResult {
  const minTotalQueries = options.minTotalQueries ?? 25;
  const minPerLanguage = options.minPerLanguage ?? 5;

  const parsed = evaluationDatasetSchema.safeParse(rawDataset);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Invalid evaluation dataset schema. The dataset must be an envelope ` +
        `{corpusFingerprint, generatedAt, generatorModel, records} — a bare ` +
        `record array has no corpus binding and cannot be trusted. ${detail}`,
    );
  }

  const records = parsed.data.records as EvaluationQueryRecord[];
  if (records.length < minTotalQueries) {
    throw new Error(
      `Dataset must contain at least ${minTotalQueries} records. Found ${records.length}.`,
    );
  }

  const seenIds = new Set<string>();
  for (const record of records) {
    if (seenIds.has(record.id)) {
      throw new Error(`Duplicate query id found: ${record.id}`);
    }
    seenIds.add(record.id);
  }

  const answerable = records.filter(
    (record) => record.question_type !== "unanswerable",
  );

  // Language floors apply to the answerable slice: unanswerable questions
  // measure abstention, not retrieval, so they cannot pad a language's count.
  const languageCounts = emptyLanguageCounts();
  for (const record of answerable) {
    languageCounts[record.language] += 1;
  }

  // The per-language minimum applies only to languages the dataset actually
  // contains: a corpus-derived golden set covers exactly the languages of the
  // real documents (e.g. EN+DE), and demanding FR/IT/ES queries against a
  // corpus with no FR/IT/ES text would only force fabricated records.
  for (const language of EVALUATION_LANGUAGES) {
    if (
      languageCounts[language] > 0 &&
      languageCounts[language] < minPerLanguage
    ) {
      throw new Error(
        `Dataset must contain at least ${minPerLanguage} answerable queries for language ${language}. Found ${languageCounts[language]}.`,
      );
    }
  }

  return {
    corpusFingerprint: parsed.data.corpusFingerprint,
    generatedAt: parsed.data.generatedAt,
    generatorModel: parsed.data.generatorModel,
    records,
    totalQueries: records.length,
    answerableCount: answerable.length,
    unanswerableCount: records.length - answerable.length,
    languageCounts,
  };
}
