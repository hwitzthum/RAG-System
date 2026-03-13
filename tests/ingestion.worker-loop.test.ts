import assert from "node:assert/strict";
import test from "node:test";
import { runIngestionWorker } from "../lib/ingestion/runtime/worker-loop";
import { resolveIngestionRuntimeSettings } from "../lib/ingestion/runtime/types";
import type {
  DocumentRecord,
  IngestionJob,
  JobProgress,
  ProcessJobResult,
} from "../lib/ingestion/runtime/types";
import type { ClaimIngestionJobsInput, IngestionRuntimeRepository } from "../lib/ingestion/runtime/repository";

const quietLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

class LoopRepository implements IngestionRuntimeRepository {
  private readonly queuedJobs: IngestionJob[][];
  public readonly completedJobs: string[] = [];

  constructor(queuedJobs: IngestionJob[][]) {
    this.queuedJobs = [...queuedJobs];
  }

  async claimIngestionJobs(_input: ClaimIngestionJobsInput): Promise<IngestionJob[]> {
    void _input;
    return this.queuedJobs.shift() ?? [];
  }

  async getDocument(): Promise<DocumentRecord> {
    throw new Error("not used");
  }

  async downloadDocument(): Promise<Uint8Array> {
    throw new Error("not used");
  }

  async replaceDocumentChunks(): Promise<void> {
    throw new Error("not used");
  }

  async markJobCompleted(jobId: string): Promise<void> {
    this.completedJobs.push(jobId);
  }

  async markJobFailed(): Promise<boolean> {
    throw new Error("not used");
  }

  async invalidateRetrievalCache(): Promise<void> {
    throw new Error("not used");
  }

  async saveChunkCandidates(): Promise<void> {
    throw new Error("not used");
  }

  async loadJobProgress(): Promise<JobProgress> {
    throw new Error("not used");
  }

  async updateJobStage(): Promise<void> {
    throw new Error("not used");
  }

  async updateJobProgress(): Promise<void> {
    throw new Error("not used");
  }

  async yieldJob(): Promise<void> {
    throw new Error("not used");
  }

  async insertChunkBatch(): Promise<void> {
    throw new Error("not used");
  }
}

test("runIngestionWorker exits after maxJobs batches are processed", async () => {
  const repository = new LoopRepository([
    [{ id: "job-1", documentId: "doc-1", status: "processing", attempt: 1 }],
    [{ id: "job-2", documentId: "doc-2", status: "processing", attempt: 1 }],
  ]);

  const metrics = await runIngestionWorker({
    settings: resolveIngestionRuntimeSettings({ workerPollIntervalSeconds: 1 }),
    repository,
    logger: quietLogger,
    maxJobs: 1,
    pipeline: {
      processJob: async (): Promise<ProcessJobResult> => ({
        status: "completed",
        chunksProcessed: 1,
        chunksTotal: 1,
      }),
    },
  });

  assert.equal(metrics.claimed, 1);
  assert.equal(metrics.completed, 1);
  assert.deepEqual(repository.completedJobs, ["job-1"]);
});

test("runIngestionWorker sleeps after idle poll when running continuously", async () => {
  const repository = new LoopRepository([
    [{ id: "job-1", documentId: "doc-1", status: "processing", attempt: 1 }],
    [],
  ]);

  let sleepCalls = 0;
  await assert.rejects(
    runIngestionWorker({
      settings: resolveIngestionRuntimeSettings({ workerPollIntervalSeconds: 2 }),
      repository,
      logger: quietLogger,
      sleep: async (milliseconds) => {
        sleepCalls += 1;
        assert.equal(milliseconds, 2000);
        throw new Error("stop-loop");
      },
      pipeline: {
        processJob: async (): Promise<ProcessJobResult> => ({
          status: "completed",
          chunksProcessed: 1,
          chunksTotal: 1,
        }),
      },
    }),
    /stop-loop/,
  );

  assert.equal(sleepCalls, 1);
});
