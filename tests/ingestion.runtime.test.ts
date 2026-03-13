import assert from "node:assert/strict";
import test from "node:test";
import { chunkSections, splitIntoSections } from "../lib/ingestion/runtime/chunking";
import { IngestionPipeline } from "../lib/ingestion/runtime/pipeline";
import { extractPages } from "../lib/ingestion/runtime/pdf-extractor";
import { runIngestionBatch } from "../lib/ingestion/runtime/runner";
import { resolveIngestionRuntimeSettings } from "../lib/ingestion/runtime/types";
import type {
  ChunkCandidate,
  DocumentRecord,
  IngestionJob,
  JobProgress,
  PreparedChunkRecord,
  ProcessJobResult,
} from "../lib/ingestion/runtime/types";
import type { ClaimIngestionJobsInput, IngestionRuntimeRepository } from "../lib/ingestion/runtime/repository";
import type { DocumentStatus, SupportedLanguage } from "../lib/supabase/database.types";

const quietLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

test("splitIntoSections detects uppercase headings and preserves page metadata", () => {
  const sections = splitIntoSections({
    pageNumber: 1,
    text: "OVERVIEW\nThis is an introduction paragraph.\n\nDETAILS\nSecond section content.",
  });

  assert.equal(sections.length >= 2, true);
  assert.equal(sections[0]?.sectionTitle, "Overview");
  assert.equal(sections[0]?.pageNumber, 1);
});

test("chunkSections respects overlap and emits sequential chunk indices per call", () => {
  const repeated = new Array(1800).fill("token").join(" ");
  const chunks = chunkSections({
    sections: [
      {
        pageNumber: 1,
        sectionTitle: "Overview",
        text: repeated,
      },
    ],
    language: "EN",
    targetTokens: 700,
    overlapTokens: 120,
    minChars: 20,
  });

  assert.equal(chunks.length >= 3, true);
  assert.equal(chunks[0]?.chunkIndex, 0);
});

test("chunkSections emits relaxed fallback chunk for short but meaningful sections", () => {
  const chunks = chunkSections({
    sections: [
      {
        pageNumber: 1,
        sectionTitle: "Overview",
        text: "Short section text that should still be indexed.",
      },
    ],
    language: "EN",
    targetTokens: 700,
    overlapTokens: 120,
    minChars: 120,
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.chunkIndex, 0);
  assert.equal(chunks[0]?.content.includes("still be indexed"), true);
});

class FakeRepository implements IngestionRuntimeRepository {
  public readonly document: DocumentRecord = {
    id: "doc-1",
    storagePath: "uploads/doc-1.pdf",
    sha256: "abc123",
    title: "Test",
    language: "EN",
    status: "queued",
    ingestionVersion: 1,
  };

  public readonly statusUpdates: Array<{ documentId: string; status: DocumentStatus; language?: SupportedLanguage | null }> = [];
  public readonly replacedChunksHistory: PreparedChunkRecord[][] = [];
  public readonly completedJobs: string[] = [];
  public claimedJobs: IngestionJob[] = [];
  public readonly failedCalls: Array<{ jobId: string; message: string }> = [];
  public retrievalCacheInvalidationCalls = 0;
  public deadLetterIds = new Set<string>();

  // Incremental state
  public savedCandidates: ChunkCandidate[] | null = null;
  public savedChunksTotal = 0;
  public currentChunksProcessed = 0;
  public yieldedJobs: string[] = [];
  public insertedChunkBatches: PreparedChunkRecord[][] = [];

  async claimIngestionJobs(_input: ClaimIngestionJobsInput): Promise<IngestionJob[]> {
    void _input;
    return this.claimedJobs;
  }

  async getDocument(documentId: string): Promise<DocumentRecord> {
    assert.equal(documentId, this.document.id);
    return this.document;
  }

  async downloadDocument(storagePath: string): Promise<Uint8Array> {
    assert.equal(storagePath, this.document.storagePath);
    return new TextEncoder().encode("%PDF-1.7 synthetic");
  }

  async setDocumentStatus(documentId: string, status: DocumentStatus, language?: SupportedLanguage | null): Promise<void> {
    this.statusUpdates.push({ documentId, status, language });
  }

  async replaceDocumentChunks(documentId: string, chunks: PreparedChunkRecord[]): Promise<void> {
    assert.equal(documentId, this.document.id);
    this.replacedChunksHistory.push(chunks.map((chunk) => ({ ...chunk, embedding: [...chunk.embedding] })));
  }

  async markJobCompleted(jobId: string): Promise<void> {
    this.completedJobs.push(jobId);
  }

  async markJobFailed(_job: IngestionJob, _errorMessage: string): Promise<boolean> {
    this.failedCalls.push({ jobId: _job.id, message: _errorMessage });
    return this.deadLetterIds.has(_job.id);
  }

  async invalidateRetrievalCache(): Promise<void> {
    this.retrievalCacheInvalidationCalls += 1;
  }

  async saveChunkCandidates(_jobId: string, chunks: ChunkCandidate[], total: number): Promise<void> {
    this.savedCandidates = chunks;
    this.savedChunksTotal = total;
  }

  async loadJobProgress(_jobId: string): Promise<JobProgress> {
    return {
      candidates: this.savedCandidates,
      chunksProcessed: this.currentChunksProcessed,
      chunksTotal: this.savedChunksTotal,
    };
  }

  async updateJobProgress(_jobId: string, chunksProcessed: number): Promise<void> {
    this.currentChunksProcessed = chunksProcessed;
  }

  async yieldJob(jobId: string): Promise<void> {
    this.yieldedJobs.push(jobId);
  }

  async insertChunkBatch(_documentId: string, chunks: PreparedChunkRecord[]): Promise<void> {
    this.insertedChunkBatches.push(chunks.map((chunk) => ({ ...chunk, embedding: [...chunk.embedding] })));
  }
}

test("extractPages falls back to operator extraction when robust parser cannot parse input bytes", async () => {
  const warnings: string[] = [];
  const pages = await extractPages(
    new TextEncoder().encode("BT (Hello World) Tj ET BT (Second line) Tj ET"),
    false,
    {
      info: () => undefined,
      warn: (message) => {
        warnings.push(String(message));
      },
      error: () => undefined,
    },
  );

  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.text.includes("Hello World"), true);
  assert.equal(warnings.includes("pdfjs_extraction_failed"), true);
});

test("extractPages fallback parses TJ arrays with literal operands", async () => {
  const pages = await extractPages(
    new TextEncoder().encode("BT [(Von der Praxis) 120 (zum System)] TJ ET"),
    false,
    {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  );

  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.text.includes("Von der Praxis"), true);
  assert.equal(pages[0]?.text.includes("zum System"), true);
});

test("IngestionPipeline extracts and processes all chunks in a single invocation when chunksPerRun is large", async () => {
  const repository = new FakeRepository();
  const settings = resolveIngestionRuntimeSettings({
    openAiApiKey: null,
    contextEnabled: false,
    embeddingDim: 3,
    chunkMinChars: 20,
    chunkTargetTokens: 700,
    chunkOverlapTokens: 120,
    chunksPerRun: 100, // Large enough to process all chunks in one batch
  });

  const pipeline = new IngestionPipeline({
    settings,
    repository,
    logger: quietLogger,
    extractPagesFn: async () => [
      {
        pageNumber: 1,
        text:
          "OVERVIEW\nThis is the first section with enough content to become one chunk.\n\n" +
          "DETAILS\nThis is the second section with enough content to become one chunk as well.",
      },
    ],
    contextGenerator: {
      enrich: async (chunks) =>
        chunks.map((chunk) => ({
          ...chunk,
          context: `Context for ${chunk.sectionTitle}`,
        })),
    },
    embeddingProvider: {
      embedTexts: async (texts) => texts.map((_text, index) => [index + 0.1, index + 0.2, index + 0.3]),
    },
  });

  const job: IngestionJob = {
    id: "job-1",
    documentId: "doc-1",
    status: "processing",
    attempt: 1,
  };

  const result = await pipeline.processJob(job);

  assert.equal(result.status, "completed");
  assert.equal(result.chunksTotal, 2);
  assert.equal(result.chunksProcessed, 2);

  // Chunks stored via insertChunkBatch (one batch)
  assert.equal(repository.insertedChunkBatches.length, 1);
  assert.deepEqual(
    repository.insertedChunkBatches[0]?.map((chunk) => chunk.chunkIndex),
    [0, 1],
  );

  // Existing chunks were cleared (replaceDocumentChunks called with empty array)
  assert.equal(repository.replacedChunksHistory.length, 1);
  assert.equal(repository.replacedChunksHistory[0]?.length, 0);

  // Document set to "ready" with detected language
  const readyUpdate = repository.statusUpdates.find((u) => u.status === "ready");
  assert.ok(readyUpdate);

  assert.equal(repository.retrievalCacheInvalidationCalls, 1);
});

test("IngestionPipeline processes chunks incrementally across multiple invocations", async () => {
  const repository = new FakeRepository();
  const settings = resolveIngestionRuntimeSettings({
    openAiApiKey: null,
    contextEnabled: false,
    embeddingDim: 3,
    chunkMinChars: 20,
    chunkTargetTokens: 700,
    chunkOverlapTokens: 120,
    chunksPerRun: 1, // Process one chunk at a time
  });

  const pipeline = new IngestionPipeline({
    settings,
    repository,
    logger: quietLogger,
    extractPagesFn: async () => [
      {
        pageNumber: 1,
        text:
          "OVERVIEW\nThis is the first section with enough content to become one chunk.\n\n" +
          "DETAILS\nThis is the second section with enough content to become one chunk as well.",
      },
    ],
    contextGenerator: {
      enrich: async (chunks) =>
        chunks.map((chunk) => ({
          ...chunk,
          context: `Context for ${chunk.sectionTitle}`,
        })),
    },
    embeddingProvider: {
      embedTexts: async (texts) => texts.map((_text, index) => [index + 0.1, index + 0.2, index + 0.3]),
    },
  });

  const job: IngestionJob = {
    id: "job-inc",
    documentId: "doc-1",
    status: "processing",
    attempt: 1,
  };

  // First invocation: extract + process chunk 0 only
  const r1 = await pipeline.processJob(job);
  assert.equal(r1.status, "partial");
  assert.equal(r1.chunksProcessed, 1);
  assert.equal(r1.chunksTotal, 2);
  assert.equal(repository.insertedChunkBatches.length, 1);
  assert.equal(repository.insertedChunkBatches[0]?.length, 1);
  assert.equal(repository.insertedChunkBatches[0]?.[0]?.chunkIndex, 0);

  // Second invocation: process chunk 1 (candidates loaded from saved state)
  const r2 = await pipeline.processJob(job);
  assert.equal(r2.status, "completed");
  assert.equal(r2.chunksProcessed, 2);
  assert.equal(r2.chunksTotal, 2);
  assert.equal(repository.insertedChunkBatches.length, 2);
  assert.equal(repository.insertedChunkBatches[1]?.length, 1);
  assert.equal(repository.insertedChunkBatches[1]?.[0]?.chunkIndex, 1);

  // Document set to "ready" only on completion
  const readyUpdate = repository.statusUpdates.find((u) => u.status === "ready");
  assert.ok(readyUpdate);
  assert.equal(repository.retrievalCacheInvalidationCalls, 1);
});

test("IngestionPipeline uses relaxed document fallback when all sections are below minChars", async () => {
  const repository = new FakeRepository();
  const settings = resolveIngestionRuntimeSettings({
    openAiApiKey: null,
    contextEnabled: false,
    embeddingDim: 3,
    chunkMinChars: 120,
    chunkTargetTokens: 700,
    chunkOverlapTokens: 120,
    chunksPerRun: 100,
  });

  const pipeline = new IngestionPipeline({
    settings,
    repository,
    logger: quietLogger,
    extractPagesFn: async () => [
      {
        pageNumber: 1,
        text: "OVERVIEW\nTiny text.",
      },
    ],
    contextGenerator: {
      enrich: async (chunks) =>
        chunks.map((chunk) => ({
          ...chunk,
          context: `Context for ${chunk.sectionTitle}`,
        })),
    },
    embeddingProvider: {
      embedTexts: async (texts) => texts.map((_text, index) => [index + 0.1, index + 0.2, index + 0.3]),
    },
  });

  const result = await pipeline.processJob({
    id: "job-short",
    documentId: "doc-1",
    status: "processing",
    attempt: 1,
  });

  assert.equal(result.status, "completed");
  assert.equal(repository.insertedChunkBatches.length, 1);
  assert.equal(repository.insertedChunkBatches[0]?.length, 1);
  assert.equal(repository.insertedChunkBatches[0]?.[0]?.content.includes("Tiny text"), true);
  assert.equal(repository.retrievalCacheInvalidationCalls, 1);
});

test("runIngestionBatch reports completed, partial, failed, and dead-letter outcomes with per-job metrics", async () => {
  const repository = new FakeRepository();
  repository.claimedJobs = [
    { id: "job-1", documentId: "doc-1", status: "processing", attempt: 1 },
    { id: "job-2", documentId: "doc-2", status: "processing", attempt: 2 },
    { id: "job-3", documentId: "doc-3", status: "processing", attempt: 3 },
  ];
  repository.deadLetterIds.add("job-3");

  const settings = resolveIngestionRuntimeSettings({
    ingestionBatchSize: 3,
  });

  const metrics = await runIngestionBatch({
    settings,
    repository,
    logger: quietLogger,
    pipeline: {
      processJob: async (job): Promise<ProcessJobResult> => {
        if (job.id === "job-2") {
          throw new Error("transient failure");
        }
        if (job.id === "job-3") {
          throw new Error("terminal failure");
        }
        return { status: "completed", chunksProcessed: 1, chunksTotal: 1 };
      },
    },
  });

  assert.equal(metrics.claimed, 3);
  assert.equal(metrics.completed, 1);
  assert.equal(metrics.failed, 1);
  assert.equal(metrics.deadLettered, 1);
  assert.equal(repository.failedCalls.length, 2);
  assert.equal(repository.completedJobs.length, 1);
  assert.equal(repository.completedJobs[0], "job-1");
  assert.equal(metrics.jobs.length, 3);
  assert.deepEqual(
    metrics.jobs.map((job) => [job.id, job.outcome]),
    [
      ["job-1", "completed"],
      ["job-2", "failed"],
      ["job-3", "dead_letter"],
    ],
  );
});

test("runIngestionBatch yields partial jobs back to queue", async () => {
  const repository = new FakeRepository();
  repository.claimedJobs = [
    { id: "job-partial", documentId: "doc-1", status: "processing", attempt: 1 },
  ];

  const settings = resolveIngestionRuntimeSettings({
    ingestionBatchSize: 1,
  });

  const metrics = await runIngestionBatch({
    settings,
    repository,
    logger: quietLogger,
    pipeline: {
      processJob: async (): Promise<ProcessJobResult> => {
        return { status: "partial", chunksProcessed: 5, chunksTotal: 20 };
      },
    },
  });

  assert.equal(metrics.claimed, 1);
  assert.equal(metrics.completed, 0);
  assert.equal(metrics.partial, 1);
  assert.equal(metrics.failed, 0);
  assert.equal(repository.yieldedJobs.length, 1);
  assert.equal(repository.yieldedJobs[0], "job-partial");
  assert.deepEqual(
    metrics.jobs.map((job) => [job.id, job.outcome]),
    [["job-partial", "partial"]],
  );
});
