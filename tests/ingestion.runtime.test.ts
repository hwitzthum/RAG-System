import assert from "node:assert/strict";
import test from "node:test";
import { chunkSections, splitIntoSections } from "../lib/ingestion/runtime/chunking";
import { IngestionPipeline } from "../lib/ingestion/runtime/pipeline";
import { extractPages } from "../lib/ingestion/runtime/pdf-extractor";
import { runIngestionBatch } from "../lib/ingestion/runtime/runner";
import { resolveIngestionRuntimeSettings } from "../lib/ingestion/runtime/types";
import type {
  DocumentRecord,
  IngestionJob,
  PreparedChunkRecord,
} from "../lib/ingestion/runtime/types";
import type { ClaimIngestionJobsInput, IngestionRuntimeRepository } from "../lib/ingestion/runtime/repository";
import type { DocumentStatus, SupportedLanguage } from "../lib/supabase/database.types";

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
  public deadLetterIds = new Set<string>();

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

test("IngestionPipeline reindexes per-section chunks and remains idempotent across reprocessing", async () => {
  const repository = new FakeRepository();
  const settings = resolveIngestionRuntimeSettings({
    openAiApiKey: null,
    contextEnabled: false,
    embeddingDim: 3,
    chunkMinChars: 20,
    chunkTargetTokens: 700,
    chunkOverlapTokens: 120,
  });

  const pipeline = new IngestionPipeline({
    settings,
    repository,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
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

  await pipeline.processJob(job);
  await pipeline.processJob(job);

  assert.equal(repository.replacedChunksHistory.length, 2);
  const firstPass = repository.replacedChunksHistory[0] ?? [];
  const secondPass = repository.replacedChunksHistory[1] ?? [];

  assert.deepEqual(
    firstPass.map((chunk) => chunk.chunkIndex),
    [0, 1],
  );
  assert.deepEqual(
    secondPass.map((chunk) => chunk.chunkIndex),
    [0, 1],
  );

  const firstSignature = firstPass.map((chunk) => [chunk.chunkIndex, chunk.pageNumber, chunk.sectionTitle]);
  const secondSignature = secondPass.map((chunk) => [chunk.chunkIndex, chunk.pageNumber, chunk.sectionTitle]);
  assert.deepEqual(firstSignature, secondSignature);
  assert.deepEqual(repository.completedJobs, ["job-1", "job-1"]);
});

test("runIngestionBatch reports completed, failed, and dead-letter outcomes with per-job metrics", async () => {
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
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    pipeline: {
      processJob: async (job) => {
        if (job.id === "job-2") {
          throw new Error("transient failure");
        }
        if (job.id === "job-3") {
          throw new Error("terminal failure");
        }
      },
    },
  });

  assert.equal(metrics.claimed, 3);
  assert.equal(metrics.completed, 1);
  assert.equal(metrics.failed, 1);
  assert.equal(metrics.deadLettered, 1);
  assert.equal(repository.failedCalls.length, 2);
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
