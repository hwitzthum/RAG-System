import { z } from "zod";

/**
 * Field schemas for environment variables that more than one config module
 * declares.
 *
 * `lib/config/env.ts` validates the whole application environment at import
 * time and throws on a missing required variable, so neither the ingestion
 * worker's settings resolver nor the test suite can import it — both run
 * without a full environment. Each side therefore used to restate the
 * variables it shared with the other, carrying its own copy of the default.
 * Those copies drifted: `INGESTION_BATCH_SIZE` read 50 here and 1 in the
 * worker, `INGESTION_LOCK_TIMEOUT_SECONDS` 900 against 120, and the README
 * documented the value no code path could produce.
 *
 * Declaring each shared variable once, here, is what makes that drift
 * impossible rather than merely corrected. A variable belongs in this module
 * as soon as a second module needs it; anything a single module reads stays
 * where it is read.
 */
export const sharedEnvFields = {
  INGESTION_BATCH_SIZE: z.coerce.number().int().positive().default(1),
  INGESTION_LOCK_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(120),
  RAG_QUERY_EMBEDDING_MODEL: z
    .string()
    .min(1)
    .default("text-embedding-3-large"),
  RAG_LLM_MODEL: z.string().min(1).default("gpt-4o-mini"),
  RAG_STORAGE_BUCKET: z.string().min(1).default("documents"),
} as const;
