import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkSections,
  splitIntoSections,
  splitPagesIntoSections,
} from "../lib/ingestion/runtime/chunking";
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
import type {
  ClaimIngestionJobsInput,
  IngestionRuntimeRepository,
} from "../lib/ingestion/runtime/repository";
import type { SupportedLanguage } from "../lib/supabase/database.types";

const quietLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function createCapturingLogger() {
  const entries: Array<{
    level: "info" | "warn" | "error";
    event: string;
    payload: Record<string, unknown> | undefined;
  }> = [];

  return {
    entries,
    logger: {
      info: (event: string, payload?: Record<string, unknown>) => {
        entries.push({ level: "info", event, payload });
      },
      warn: (event: string, payload?: Record<string, unknown>) => {
        entries.push({ level: "warn", event, payload });
      },
      error: (event: string, payload?: Record<string, unknown>) => {
        entries.push({ level: "error", event, payload });
      },
    },
  };
}

test("splitIntoSections detects uppercase headings and preserves page metadata", () => {
  const sections = splitIntoSections({
    pageNumber: 1,
    text: "OVERVIEW\nThis is an introduction paragraph.\n\nDETAILS\nSecond section content.",
  });

  assert.equal(sections.length >= 2, true);
  // Kept verbatim: the lowercase/title-case round-trip mangled acronyms and
  // German compounds (`Mandat ZüRich`) and truncated `Capacity Building`.
  assert.equal(sections[0]?.sectionTitle, "OVERVIEW");
  assert.equal(sections[0]?.pageNumber, 1);
  // The heading also leads the body, so it reaches the embedded vector.
  assert.equal(sections[0]?.text.startsWith("OVERVIEW"), true);
});

test("splitPagesIntoSections carries the heading path across page boundaries", () => {
  // Sectioning used to restart per page, so a continuation page fell back to
  // the title `Page N` and lost its ancestry entirely.
  const sections = splitPagesIntoSections([
    { pageNumber: 3, text: "5 MELDUNG VERHAELTNISSE\nIntro paragraph here." },
    { pageNumber: 4, text: "Continuation of the same section." },
  ]);

  assert.equal(sections.length, 2);
  assert.equal(sections[0]?.sectionTitle, "5 MELDUNG VERHAELTNISSE");
  assert.equal(sections[1]?.pageNumber, 4);
  assert.equal(sections[1]?.sectionTitle, "5 MELDUNG VERHAELTNISSE");
});

test("splitPagesIntoSections nests headings by numbering depth", () => {
  const sections = splitPagesIntoSections([
    {
      pageNumber: 1,
      text: "5 Meldung Veraenderter Verhaeltnisse\nIntro.\n5.4 Mutationen Krankenversicherung\nDetail text.",
    },
  ]);

  assert.equal(sections.length, 2);
  assert.equal(
    sections[0]?.sectionTitle,
    "5 Meldung Veraenderter Verhaeltnisse",
  );
  assert.equal(
    sections[1]?.sectionTitle,
    "5 Meldung Veraenderter Verhaeltnisse / 5.4 Mutationen Krankenversicherung",
  );
});

test("splitIntoSections keeps a numeric table header row in the chunk body", () => {
  // "2024 2025 2026" matched the all-caps heading pattern, so the row was
  // consumed as a section title and deleted from the text entirely — taking
  // the column labels for every figure below it with it.
  const sections = splitIntoSections({
    pageNumber: 1,
    text: "REVENUE\n2024 2025 2026\nEurope 100 120 140",
  });

  assert.equal(sections.length, 1);
  assert.equal(sections[0]?.sectionTitle, "REVENUE");
  assert.equal(sections[0]?.text.includes("2024 2025 2026"), true);
});

test("splitIntoSections preserves paragraph breaks within a section", () => {
  const sections = splitIntoSections({
    pageNumber: 2,
    text: "OVERVIEW\nFirst paragraph.\n\nSecond paragraph.\n\nDETAILS\nThird paragraph.",
  });

  assert.equal(
    sections[0]?.text.includes("First paragraph.\n\nSecond paragraph."),
    true,
  );
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

test("chunkSections merges adjacent short sections into a single adaptive chunk", () => {
  const chunks = chunkSections({
    sections: [
      {
        pageNumber: 1,
        sectionTitle: "Overview",
        text: "Short introduction about the handbook.",
      },
      {
        pageNumber: 1,
        sectionTitle: "Scope",
        text: "Short scope note describing supported cases.",
      },
    ],
    language: "EN",
    targetTokens: 80,
    overlapTokens: 20,
    minChars: 80,
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.sectionTitle, "Overview / Scope");
  assert.equal(chunks[0]?.content.includes("supported cases"), true);
});

test("chunkSections prefers paragraph-aware chunk boundaries", () => {
  const chunks = chunkSections({
    sections: [
      {
        pageNumber: 1,
        sectionTitle: "Overview",
        text: [
          "Paragraph one explains the first part of the process in a complete thought.",
          "",
          "Paragraph two explains the second part of the process in another complete thought.",
          "",
          "Paragraph three explains the third part of the process in a final complete thought.",
        ].join("\n"),
      },
    ],
    language: "EN",
    targetTokens: 28,
    overlapTokens: 6,
    minChars: 20,
  });

  assert.equal(chunks.length >= 2, true);
  assert.equal(chunks[0]?.content.includes("\n\n"), true);
});

class FakeRepository implements IngestionRuntimeRepository {
  public readonly document: DocumentRecord = {
    id: "doc-1",
    userId: null,
    storagePath: "uploads/doc-1.pdf",
    sha256: "abc123",
    title: "Test",
    summary: null,
    language: "EN",
    status: "queued",
    ingestionVersion: 1,
  };

  public documentSummaries: Array<{ documentId: string; summary: string }> = [];

  public readonly replacedChunksHistory: PreparedChunkRecord[][] = [];
  public readonly completedJobs: Array<{
    jobId: string;
    language?: SupportedLanguage | null;
  }> = [];
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
  public stageUpdates: string[] = [];

  async claimIngestionJobs(
    _input: ClaimIngestionJobsInput,
  ): Promise<IngestionJob[]> {
    void _input;
    return this.claimedJobs;
  }

  async getDocument(documentId: string): Promise<DocumentRecord> {
    assert.equal(documentId, this.document.id);
    return this.document;
  }

  async setDocumentSummary(documentId: string, summary: string): Promise<void> {
    this.documentSummaries.push({ documentId, summary });
  }

  async downloadDocument(storagePath: string): Promise<Uint8Array> {
    assert.equal(storagePath, this.document.storagePath);
    return new TextEncoder().encode("%PDF-1.7 synthetic");
  }

  async replaceDocumentChunks(
    documentId: string,
    chunks: PreparedChunkRecord[],
  ): Promise<void> {
    assert.equal(documentId, this.document.id);
    this.replacedChunksHistory.push(
      chunks.map((chunk) => ({ ...chunk, embedding: [...chunk.embedding] })),
    );
  }

  async markJobCompleted(
    jobId: string,
    language?: SupportedLanguage | null,
  ): Promise<void> {
    this.completedJobs.push({ jobId, language });
  }

  async markJobFailed(
    _job: IngestionJob,
    _errorMessage: string,
  ): Promise<boolean> {
    this.failedCalls.push({ jobId: _job.id, message: _errorMessage });
    return this.deadLetterIds.has(_job.id);
  }

  async invalidateRetrievalCache(): Promise<void> {
    this.retrievalCacheInvalidationCalls += 1;
  }

  async saveChunkCandidates(
    _jobId: string,
    chunks: ChunkCandidate[],
    total: number,
  ): Promise<void> {
    this.savedCandidates = chunks;
    this.savedChunksTotal = total;
  }

  async loadJobProgress(): Promise<JobProgress> {
    return {
      candidates: this.savedCandidates,
      chunksProcessed: this.currentChunksProcessed,
      chunksTotal: this.savedChunksTotal,
      currentStage: this.stageUpdates.at(-1) ?? null,
    };
  }

  async updateJobStage(_jobId: string, stage: string): Promise<void> {
    this.stageUpdates.push(stage);
  }

  async updateJobProgress(
    _jobId: string,
    chunksProcessed: number,
  ): Promise<void> {
    this.currentChunksProcessed = chunksProcessed;
  }

  async yieldJob(jobId: string): Promise<void> {
    this.yieldedJobs.push(jobId);
  }

  async insertChunkBatch(
    _documentId: string,
    chunks: PreparedChunkRecord[],
  ): Promise<void> {
    this.insertedChunkBatches.push(
      chunks.map((chunk) => ({ ...chunk, embedding: [...chunk.embedding] })),
    );
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
      embedTexts: async (texts) =>
        texts.map((_text, index) => [index + 0.1, index + 0.2, index + 0.3]),
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
  assert.deepEqual(repository.stageUpdates, [
    "extracting",
    "chunking",
    "clearing_chunks",
    "contextualizing",
    "embedding",
    "storing",
    "finalizing",
  ]);
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
      embedTexts: async (texts) =>
        texts.map((_text, index) => [index + 0.1, index + 0.2, index + 0.3]),
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
      embedTexts: async (texts) =>
        texts.map((_text, index) => [index + 0.1, index + 0.2, index + 0.3]),
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
  assert.equal(
    repository.insertedChunkBatches[0]?.[0]?.content.includes("Tiny text"),
    true,
  );
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
  assert.deepEqual(repository.completedJobs[0], {
    jobId: "job-1",
    language: null,
  });
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

test("runIngestionBatch emits explicit transition events for claim, completion, retry, and dead-letter", async () => {
  const repository = new FakeRepository();
  repository.claimedJobs = [
    { id: "job-1", documentId: "doc-1", status: "processing", attempt: 1 },
    { id: "job-2", documentId: "doc-2", status: "processing", attempt: 2 },
    { id: "job-3", documentId: "doc-3", status: "processing", attempt: 3 },
  ];
  repository.deadLetterIds.add("job-3");

  const { entries, logger } = createCapturingLogger();

  await runIngestionBatch({
    repository,
    logger,
    pipeline: {
      processJob: async (job): Promise<ProcessJobResult> => {
        if (job.id === "job-2") {
          throw new Error("transient failure");
        }
        if (job.id === "job-3") {
          throw new Error("terminal failure");
        }
        return {
          status: "completed",
          chunksProcessed: 2,
          chunksTotal: 2,
          documentLanguage: "EN",
        };
      },
    },
  });

  assert.deepEqual(
    entries.map((entry) => [entry.level, entry.event]),
    [
      ["info", "ingestion_job_claimed"],
      ["info", "ingestion_job_claimed"],
      ["info", "ingestion_job_claimed"],
      ["info", "ingestion_job_completed"],
      ["warn", "ingestion_job_retry_scheduled"],
      ["warn", "ingestion_job_failed"],
      ["warn", "ingestion_job_dead_lettered"],
      ["warn", "ingestion_job_failed"],
    ],
  );
});

test("runIngestionBatch loops through partial batches until completion", async () => {
  const repository = new FakeRepository();
  repository.claimedJobs = [
    { id: "job-loop", documentId: "doc-1", status: "processing", attempt: 1 },
  ];

  const settings = resolveIngestionRuntimeSettings({
    ingestionBatchSize: 1,
  });

  let callCount = 0;
  const metrics = await runIngestionBatch({
    settings,
    repository,
    logger: quietLogger,
    pipeline: {
      processJob: async (): Promise<ProcessJobResult> => {
        callCount += 1;
        if (callCount < 3) {
          return {
            status: "partial",
            chunksProcessed: callCount * 5,
            chunksTotal: 15,
          };
        }
        return { status: "completed", chunksProcessed: 15, chunksTotal: 15 };
      },
    },
  });

  assert.equal(callCount, 3);
  assert.equal(metrics.claimed, 1);
  assert.equal(metrics.completed, 1);
  assert.equal(metrics.failed, 0);
  assert.equal(repository.completedJobs.length, 1);
  assert.deepEqual(repository.completedJobs[0], {
    jobId: "job-loop",
    language: null,
  });
  assert.deepEqual(
    metrics.jobs.map((job) => [job.id, job.outcome]),
    [["job-loop", "completed"]],
  );
});

test("runIngestionBatch passes completed document language to markJobCompleted", async () => {
  const repository = new FakeRepository();
  repository.claimedJobs = [
    { id: "job-lang", documentId: "doc-1", status: "processing", attempt: 1 },
  ];

  const metrics = await runIngestionBatch({
    repository,
    logger: quietLogger,
    pipeline: {
      processJob: async (): Promise<ProcessJobResult> => ({
        status: "completed",
        chunksProcessed: 2,
        chunksTotal: 2,
        documentLanguage: "DE",
      }),
    },
  });

  assert.equal(metrics.completed, 1);
  assert.deepEqual(repository.completedJobs, [
    { jobId: "job-lang", language: "DE" },
  ]);
});

test("chunkSections bounds a merged section to adjacent pages", () => {
  // A merged section inherits the first section's pageNumber, so unbounded
  // merging relabels content: Rollen-Basierte-Arbeit-Redesign.pdf collapsed to
  // 5 chunks all claiming page 1. Forbidding cross-page merges outright then
  // cost retrieval — 15 chunks of ~54 tokens, -0.25 MRR. One page of span is
  // the compromise, and it must not chain across three pages.
  const chunks = chunkSections({
    sections: [
      { pageNumber: 1, sectionTitle: "Intro", text: "Short text on page one." },
      { pageNumber: 2, sectionTitle: "Next", text: "Short text on page two." },
      { pageNumber: 3, sectionTitle: "Last", text: "Short text on page three." },
      { pageNumber: 4, sectionTitle: "More", text: "Short text on page four." },
    ],
    language: "EN",
    targetTokens: 700,
    overlapTokens: 120,
    minChars: 200,
  });

  // Pages 1+2 merge, then 3+4 — never 1..3, which would put page-3 content
  // under page 1.
  assert.equal(chunks.length, 2);
  assert.deepEqual(
    chunks.map((chunk) => chunk.pageNumber),
    [1, 3],
  );
  assert.equal(chunks[0]?.content.includes("page two"), true);
  assert.equal(chunks[1]?.content.includes("page four"), true);
});

test("chunkSections still merges short sections within one page", () => {
  const chunks = chunkSections({
    sections: [
      { pageNumber: 4, sectionTitle: "Overview", text: "Short introduction." },
      { pageNumber: 4, sectionTitle: "Scope", text: "Short scope note here." },
    ],
    language: "EN",
    targetTokens: 700,
    overlapTokens: 120,
    minChars: 200,
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.pageNumber, 4);
  assert.equal(chunks[0]?.sectionTitle, "Overview / Scope");
});

test("chunkSections terminates when an oversized paragraph follows a normal one", () => {
  // Regression: the oversized-paragraph branch used to break out to "flush"
  // a buffer holding only carried-over overlap. That re-entered the outer
  // pass with the same overlap and the same oversized paragraph, so the
  // paragraph index never advanced and the chunker appended the overlap
  // forever — the worker died of heap exhaustion partway through ingestion.
  const normalParagraph =
    "The subject retains its potential to know throughout the change.";
  const oversizedParagraph = Array.from(
    { length: 60 },
    (_, index) =>
      `Perception is a form of alteration in the sense organ, as argument ${index} shows.`,
  ).join(" ");

  const chunks = chunkSections({
    sections: [
      {
        pageNumber: 1,
        sectionTitle: "Overview",
        text: `${normalParagraph}\n\n${oversizedParagraph}`,
      },
    ],
    language: "EN",
    targetTokens: 40,
    overlapTokens: 8,
    minChars: 20,
  });

  assert.equal(chunks.length > 0, true);
  // The overlap must not be re-emitted as a chunk of its own.
  const contents = chunks.map((chunk) => chunk.content);
  assert.equal(new Set(contents).size, contents.length);
  assert.deepEqual(
    chunks.map((chunk) => chunk.chunkIndex),
    chunks.map((_, index) => index),
  );
});

test("runIngestionBatch yields an unfinished job once the run is out of time", async () => {
  // A document too large for one invocation used to run until the platform
  // killed the function, which left the job locked with no error and spent a
  // retry. Checking in voluntarily requeues it with its progress intact.
  const repository = new FakeRepository();
  repository.claimedJobs = [
    { id: "job-big", documentId: "doc-1", status: "processing", attempt: 1 },
  ];

  let batches = 0;
  const metrics = await runIngestionBatch({
    repository,
    logger: quietLogger,
    deadlineAt: Date.now() - 1,
    pipeline: {
      processJob: async (): Promise<ProcessJobResult> => {
        batches += 1;
        return { status: "partial", chunksProcessed: 5, chunksTotal: 500 };
      },
    },
  });

  assert.equal(batches, 1);
  assert.equal(metrics.yielded, 1);
  assert.equal(metrics.completed, 0);
  assert.equal(metrics.failed, 0);
  assert.deepEqual(repository.yieldedJobs, ["job-big"]);
  // Not finalized, and not counted as a failure against the retry budget.
  assert.deepEqual(repository.completedJobs, []);
  assert.deepEqual(repository.failedCalls, []);
});

test("runIngestionBatch keeps batching an unfinished job while time remains", async () => {
  const repository = new FakeRepository();
  repository.claimedJobs = [
    { id: "job-ok", documentId: "doc-1", status: "processing", attempt: 1 },
  ];

  let batches = 0;
  const metrics = await runIngestionBatch({
    repository,
    logger: quietLogger,
    deadlineAt: Date.now() + 60_000,
    pipeline: {
      processJob: async (): Promise<ProcessJobResult> => {
        batches += 1;
        return batches < 3
          ? { status: "partial", chunksProcessed: batches * 5, chunksTotal: 15 }
          : {
              status: "completed",
              chunksProcessed: 15,
              chunksTotal: 15,
              documentLanguage: "EN",
            };
      },
    },
  });

  assert.equal(batches, 3);
  assert.equal(metrics.yielded, 0);
  assert.equal(metrics.completed, 1);
  assert.deepEqual(repository.yieldedJobs, []);
});

test("runIngestionBatch yields when the next batch is projected to overrun", async () => {
  // The deadline is still ahead, but not by enough to fit another batch of the
  // size just measured. Starting one anyway is how the run used to get killed
  // mid-batch, losing that batch's work and burning a retry.
  const repository = new FakeRepository();
  repository.claimedJobs = [
    { id: "job-proj", documentId: "doc-1", status: "processing", attempt: 1 },
  ];

  let batches = 0;
  const metrics = await runIngestionBatch({
    repository,
    logger: quietLogger,
    // Comfortably in the future, but shorter than 1.3x the batch below.
    deadlineAt: Date.now() + 120,
    pipeline: {
      processJob: async (): Promise<ProcessJobResult> => {
        batches += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { status: "partial", chunksProcessed: 5, chunksTotal: 500 };
      },
    },
  });

  assert.equal(batches, 1);
  assert.equal(metrics.yielded, 1);
  assert.deepEqual(repository.yieldedJobs, ["job-proj"]);
});

test("IngestionPipeline extracts the document once across a resumed run", async () => {
  // Each batch re-entered processJob and re-parsed the whole PDF purely to
  // rebuild the whole-document context string — ~20% of every batch on a book.
  const repository = new FakeRepository();
  const job: IngestionJob = {
    id: "job-cache",
    documentId: repository.document.id,
    status: "processing",
    attempt: 1,
  };

  let extractCalls = 0;
  const pipeline = new IngestionPipeline({
    settings: {
      ...resolveIngestionRuntimeSettings(),
      chunksPerRun: 1,
      contextEnabled: false,
      embeddingDim: 3,
      // Small budgets so each paragraph becomes its own chunk, forcing the
      // run to span several batches.
      chunkTargetTokens: 20,
      chunkOverlapTokens: 4,
      chunkMinChars: 20,
    },
    repository,
    logger: quietLogger,
    extractPagesFn: async () => {
      extractCalls += 1;
      return [
        {
          pageNumber: 1,
          text: [
            "First paragraph of the document body for the run.",
            "",
            "Second paragraph of the document body for the run.",
            "",
            "Third paragraph of the document body for the run.",
          ].join("\n"),
          method: "pdfjs" as const,
        },
      ];
    },
    contextGenerator: {
      enrich: async (chunks) =>
        chunks.map((chunk) => ({ ...chunk, context: "ctx" })),
    },
    embeddingProvider: {
      embedTexts: async (inputs) => inputs.map(() => [0.1, 0.2, 0.3]),
    },
    resolveJobSecrets: async () => ({
      openAiApiKey: null,
      anthropicApiKey: null,
    }),
  });

  let batches = 1;
  let result = await pipeline.processJob(job);
  const firstPassExtractCalls = extractCalls;
  while (result.status === "partial") {
    result = await pipeline.processJob(job);
    batches += 1;
  }

  assert.equal(result.status, "completed");
  // The cache is only meaningful if the run actually spans several batches.
  assert.equal(batches > 1, true);
  assert.equal(firstPassExtractCalls, 1);
  // Every later batch reads the cached text instead of re-parsing the PDF.
  assert.equal(extractCalls, 1);
});
