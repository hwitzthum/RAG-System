import { z } from "zod";
import type { SupportedLanguage } from "@/lib/contracts/retrieval";
import {
  EVALUATION_LANGUAGES,
  type DatasetValidationOptions,
  type DatasetValidationResult,
  type EvaluationQueryRecord,
} from "@/lib/evaluation/types";

const evaluationQuerySchema = z.object({
  id: z.string().min(1),
  language: z.enum(EVALUATION_LANGUAGES),
  question: z.string().min(1),
  expected_document: z.string().min(1),
  expected_section: z.string().min(1),
  expected_pages: z.array(z.number().int().positive()).min(1),
  acceptable_answer_points: z.array(z.string().min(1)).min(1),
});

const evaluationDatasetSchema = z.array(evaluationQuerySchema);

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
  const minTotalQueries = options.minTotalQueries ?? 200;
  const minPerLanguage = options.minPerLanguage ?? 40;

  const parsed = evaluationDatasetSchema.safeParse(rawDataset);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid evaluation dataset schema. ${detail}`);
  }

  const records = parsed.data as EvaluationQueryRecord[];
  if (records.length < minTotalQueries) {
    throw new Error(`Dataset must contain at least ${minTotalQueries} records. Found ${records.length}.`);
  }

  const seenIds = new Set<string>();
  for (const record of records) {
    if (seenIds.has(record.id)) {
      throw new Error(`Duplicate query id found: ${record.id}`);
    }
    seenIds.add(record.id);
  }

  const languageCounts = emptyLanguageCounts();
  for (const record of records) {
    languageCounts[record.language] += 1;
  }

  for (const language of EVALUATION_LANGUAGES) {
    if (languageCounts[language] < minPerLanguage) {
      throw new Error(
        `Dataset must contain at least ${minPerLanguage} queries for language ${language}. Found ${languageCounts[language]}.`,
      );
    }
  }

  return {
    records,
    totalQueries: records.length,
    languageCounts,
  };
}

