import { IngestionPipeline } from "@/lib/ingestion/runtime/pipeline";
import { resolveIngestionRuntimeSettings } from "@/lib/ingestion/runtime/types";
import type { IngestionRuntimeRepository } from "@/lib/ingestion/runtime/repository";
import type {
  IngestionRuntimeSettings,
  ProcessJobResult,
  RuntimeLogger,
} from "@/lib/ingestion/runtime/types";

/**
 * How much longer than its predecessor the next batch is assumed to take. The
 * deadline check is a projection, not a cliff: a run stops starting batches
 * once the one it would start is unlikely to land in time, rather than
 * discovering that only when the platform kills it mid-batch.
 */
const BATCH_DURATION_SAFETY_FACTOR = 1.3;

export type IngestionRunMetrics = {
  claimed: number;
  completed: number;
  failed: number;
  deadLettered: number;
  yielded: number;
  durationMs: number;
  jobs: Array<{
    id: string;
    outcome: "completed" | "failed" | "dead_letter" | "yielded";
    attempt: number;
    error?: string;
  }>;
};

export async function runIngestionBatch(input?: {
  settings?: IngestionRuntimeSettings;
  logger?: RuntimeLogger;
  repository?: IngestionRuntimeRepository;
  pipeline?: Pick<IngestionPipeline, "processJob">;
  /**
   * Wall-clock instant by which this run must be finished. A batch is only
   * started when it is projected to complete before it. Set by callers that
   * run under a hard platform limit; omitted by the long-lived worker, which
   * has no deadline to respect.
   */
  deadlineAt?: number;
}): Promise<IngestionRunMetrics> {
  const logger = input?.logger ?? console;
  const settings = input?.settings ?? resolveIngestionRuntimeSettings();
  const repository =
    input?.repository ??
    new (await import("./repository")).SupabaseIngestionRuntimeRepository({
      settings,
      logger,
    });
  const pipeline =
    input?.pipeline ??
    new IngestionPipeline({
      settings,
      repository,
      logger,
    });

  const startedAt = Date.now();
  const jobs = await repository.claimIngestionJobs({
    workerName: settings.workerName,
    batchSize: settings.ingestionBatchSize,
    lockTimeoutSeconds: settings.lockTimeoutSeconds,
    maxRetries: settings.maxRetries,
  });

  for (const job of jobs) {
    logger.info("ingestion_job_claimed", {
      jobId: job.id,
      documentId: job.documentId,
      attempt: job.attempt,
      workerName: settings.workerName,
    });
  }

  const metrics: IngestionRunMetrics = {
    claimed: jobs.length,
    completed: 0,
    failed: 0,
    deadLettered: 0,
    yielded: 0,
    durationMs: 0,
    jobs: [],
  };

  for (const job of jobs) {
    try {
      // Loop through all batches for this job until complete.
      // Progress is saved after each batch, so if Vercel kills the function
      // mid-loop, the next invocation resumes from the last saved position.
      let result: ProcessJobResult;
      let yielded = false;
      do {
        const batchStartedAt = Date.now();
        result = await pipeline.processJob(job);
        const batchDurationMs = Date.now() - batchStartedAt;

        if (result.status === "partial") {
          logger.info("ingestion_job_batch_done", {
            jobId: job.id,
            chunksProcessed: result.chunksProcessed,
            chunksTotal: result.chunksTotal,
          });

          /*
           * A document larger than one invocation's budget used to run until
           * the platform killed the function. The kill left the job locked in
           * `processing` with no error, and the reclaim that eventually
           * followed spent one of its `maxRetries` — so a long document
           * exhausted its retry budget on timeouts and dead-lettered no
           * matter how much progress it had checkpointed. Checking in
           * voluntarily requeues the job with its attempt counter reset, so
           * only real failures count against retries.
           */
          if (
            input?.deadlineAt !== undefined &&
            Date.now() + batchDurationMs * BATCH_DURATION_SAFETY_FACTOR >=
              input.deadlineAt
          ) {
            await repository.yieldJob(job.id);
            yielded = true;
          }
        }
      } while (result.status === "partial" && !yielded);

      if (yielded) {
        logger.info("ingestion_job_yielded", {
          jobId: job.id,
          documentId: job.documentId,
          attempt: job.attempt,
          chunksProcessed: result.chunksProcessed,
          chunksTotal: result.chunksTotal,
        });
        metrics.yielded += 1;
        metrics.jobs.push({
          id: job.id,
          outcome: "yielded",
          attempt: job.attempt,
        });
        break;
      }

      // All chunks processed — finalize
      await repository.markJobCompleted(
        job.id,
        result.documentLanguage ?? null,
      );
      logger.info("ingestion_job_completed", {
        jobId: job.id,
        documentId: job.documentId,
        attempt: job.attempt,
        chunksProcessed: result.chunksProcessed,
        chunksTotal: result.chunksTotal,
        documentLanguage: result.documentLanguage ?? null,
      });
      metrics.completed += 1;
      metrics.jobs.push({
        id: job.id,
        outcome: "completed",
        attempt: job.attempt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      const deadLettered = await repository.markJobFailed(job, message);
      if (deadLettered) {
        logger.warn("ingestion_job_dead_lettered", {
          jobId: job.id,
          documentId: job.documentId,
          attempt: job.attempt,
          message,
        });
        metrics.deadLettered += 1;
        metrics.jobs.push({
          id: job.id,
          outcome: "dead_letter",
          attempt: job.attempt,
          error: message,
        });
      } else {
        logger.warn("ingestion_job_retry_scheduled", {
          jobId: job.id,
          documentId: job.documentId,
          attempt: job.attempt,
          message,
        });
        metrics.failed += 1;
        metrics.jobs.push({
          id: job.id,
          outcome: "failed",
          attempt: job.attempt,
          error: message,
        });
      }
      logger.warn("ingestion_job_failed", {
        jobId: job.id,
        documentId: job.documentId,
        attempt: job.attempt,
        deadLettered,
        message,
      });
    }
  }

  metrics.durationMs = Date.now() - startedAt;
  return metrics;
}
