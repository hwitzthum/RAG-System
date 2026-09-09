import assert from "node:assert/strict";
import test from "node:test";
import { sharedEnvFields } from "@/lib/config/env-fields";
import { resolveIngestionEnv } from "@/lib/config/ingestion-env";

const OWNED_KEYS = [
  "WORKER_NAME",
  "WORKER_POLL_INTERVAL_SECONDS",
  "INGESTION_BATCH_SIZE",
  "WORKER_MAX_RETRIES",
  "WORKER_CHUNK_TARGET_TOKENS",
  "WORKER_CHUNK_OVERLAP_TOKENS",
  "WORKER_CHUNK_MIN_CHARS",
  "WORKER_CONTEXT_MODEL",
  "RAG_LLM_MODEL",
  "WORKER_CONTEXT_ENABLED",
  "WORKER_CONTEXT_MAX_CHARS",
  "WORKER_EMBEDDING_MODEL",
  "RAG_QUERY_EMBEDDING_MODEL",
  "WORKER_EMBEDDING_DIM",
  "WORKER_EMBEDDING_BATCH_SIZE",
  "WORKER_OPENAI_TIMEOUT_SECONDS",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "WORKER_EMBEDDING_DIMENSIONS",
  "WORKER_OCR_FALLBACK_ENABLED",
  "WORKER_OCR_MODEL",
  "WORKER_LOCK_TIMEOUT_SECONDS",
  "INGESTION_LOCK_TIMEOUT_SECONDS",
  "WORKER_CHUNKS_PER_RUN",
  "WORKER_CHUNK_INSERT_BATCH_SIZE",
  "RAG_STORAGE_BUCKET",
] as const;

/**
 * Runs `body` against exactly the supplied ingestion variables, with every
 * other one removed, so a value inherited from the developer's shell cannot
 * make an assertion about a default pass or fail for the wrong reason.
 */
function withEnv(values: Partial<Record<string, string>>, body: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const key of OWNED_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }

  try {
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
    body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("resolveIngestionEnv applies the documented defaults when nothing is set", () => {
  withEnv({}, () => {
    const settings = resolveIngestionEnv();

    assert.equal(settings.ingestionBatchSize, 1);
    assert.equal(settings.lockTimeoutSeconds, 120);
    assert.equal(settings.workerName, "rag-ingestion-worker");
    assert.equal(settings.contextModel, "gpt-4o-mini");
    assert.equal(settings.embeddingModel, "text-embedding-3-large");
    assert.equal(settings.ragStorageBucket, "documents");
    assert.equal(settings.contextEnabled, true);
    assert.equal(settings.openAiApiKey, null);
  });
});

test("the shared fields carry the same defaults the worker resolves to", () => {
  withEnv({}, () => {
    const settings = resolveIngestionEnv();

    assert.equal(
      sharedEnvFields.INGESTION_BATCH_SIZE.parse(undefined),
      settings.ingestionBatchSize,
    );
    assert.equal(
      sharedEnvFields.INGESTION_LOCK_TIMEOUT_SECONDS.parse(undefined),
      settings.lockTimeoutSeconds,
    );
    assert.equal(
      sharedEnvFields.RAG_LLM_MODEL.parse(undefined),
      settings.contextModel,
    );
    assert.equal(
      sharedEnvFields.RAG_QUERY_EMBEDDING_MODEL.parse(undefined),
      settings.embeddingModel,
    );
    assert.equal(
      sharedEnvFields.RAG_STORAGE_BUCKET.parse(undefined),
      settings.ragStorageBucket,
    );
  });
});

test("WORKER_-prefixed overrides win over the variables they fall back to", () => {
  withEnv(
    {
      RAG_LLM_MODEL: "gpt-4.1",
      WORKER_CONTEXT_MODEL: "gpt-4o",
      RAG_QUERY_EMBEDDING_MODEL: "text-embedding-3-small",
      WORKER_EMBEDDING_MODEL: "text-embedding-3-large",
      INGESTION_LOCK_TIMEOUT_SECONDS: "900",
      WORKER_LOCK_TIMEOUT_SECONDS: "300",
    },
    () => {
      const settings = resolveIngestionEnv();

      assert.equal(settings.contextModel, "gpt-4o");
      assert.equal(settings.embeddingModel, "text-embedding-3-large");
      assert.equal(settings.lockTimeoutSeconds, 300);
    },
  );
});

test("the fallback variables apply when no WORKER_ override is present", () => {
  withEnv(
    {
      RAG_LLM_MODEL: "gpt-4.1",
      RAG_QUERY_EMBEDDING_MODEL: "text-embedding-3-small",
      INGESTION_LOCK_TIMEOUT_SECONDS: "900",
    },
    () => {
      const settings = resolveIngestionEnv();

      assert.equal(settings.contextModel, "gpt-4.1");
      assert.equal(settings.embeddingModel, "text-embedding-3-small");
      assert.equal(settings.lockTimeoutSeconds, 900);
    },
  );
});

test("a non-numeric value is refused instead of silently becoming the default", () => {
  withEnv({ WORKER_CHUNK_TARGET_TOKENS: "abc" }, () => {
    assert.throws(
      () => resolveIngestionEnv(),
      /Invalid ingestion environment:[\s\S]*WORKER_CHUNK_TARGET_TOKENS/,
    );
  });
});

test("a non-positive value is refused rather than replaced", () => {
  withEnv({ INGESTION_BATCH_SIZE: "0" }, () => {
    assert.throws(
      () => resolveIngestionEnv(),
      /Invalid ingestion environment:[\s\S]*INGESTION_BATCH_SIZE/,
    );
  });
});

test("boolean flags accept the same spellings as the application schema", () => {
  withEnv({ WORKER_CONTEXT_ENABLED: "0" }, () => {
    assert.equal(resolveIngestionEnv().contextEnabled, false);
  });
  withEnv({ WORKER_CONTEXT_ENABLED: "false" }, () => {
    assert.equal(resolveIngestionEnv().contextEnabled, false);
  });
  withEnv({ WORKER_CONTEXT_ENABLED: "1" }, () => {
    assert.equal(resolveIngestionEnv().contextEnabled, true);
  });
});

test("an unrecognised boolean spelling is refused, not read as the default", () => {
  withEnv({ WORKER_OCR_FALLBACK_ENABLED: "yes" }, () => {
    assert.throws(
      () => resolveIngestionEnv(),
      /Invalid ingestion environment:[\s\S]*WORKER_OCR_FALLBACK_ENABLED/,
    );
  });
});

test("surrounding whitespace does not defeat a value or a default", () => {
  withEnv({ WORKER_NAME: "  soak-worker\n", RAG_STORAGE_BUCKET: "   " }, () => {
    const settings = resolveIngestionEnv();

    assert.equal(settings.workerName, "soak-worker");
    assert.equal(settings.ragStorageBucket, "documents");
  });
});
