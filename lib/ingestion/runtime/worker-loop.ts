import {
  runIngestionBatch,
  type IngestionRunMetrics,
} from "@/lib/ingestion/runtime/runner";
import { IngestionPipeline } from "@/lib/ingestion/runtime/pipeline";
import {
  resolveIngestionRuntimeSettings,
  type IngestionRuntimeSettings,
  type RuntimeLogger,
} from "@/lib/ingestion/runtime/types";
import type { IngestionRuntimeRepository } from "@/lib/ingestion/runtime/repository";

export type IngestionWorkerLoopInput = {
  settings?: IngestionRuntimeSettings;
  logger?: RuntimeLogger;
  repository?: IngestionRuntimeRepository;
  pipeline?: Pick<IngestionPipeline, "processJob">;
  maxJobs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Forwarded to each batch; see `runIngestionBatch`. */
  deadlineAt?: number;
};

export async function runIngestionWorker(
  input: IngestionWorkerLoopInput = {},
): Promise<IngestionRunMetrics> {
  const logger = input.logger ?? console;
  const settings = input.settings ?? resolveIngestionRuntimeSettings();
  const sleep =
    input.sleep ??
    ((milliseconds: number) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxJobs = Math.max(0, input.maxJobs ?? 0);

  const aggregate: IngestionRunMetrics = {
    claimed: 0,
    completed: 0,
    failed: 0,
    deadLettered: 0,
    yielded: 0,
    durationMs: 0,
    jobs: [],
  };

  const startedAt = Date.now();
  let processedBatches = 0;

  for (;;) {
    const metrics = await runIngestionBatch({
      settings,
      logger,
      repository: input.repository,
      pipeline: input.pipeline,
      deadlineAt: input.deadlineAt,
    });

    aggregate.claimed += metrics.claimed;
    aggregate.completed += metrics.completed;
    aggregate.failed += metrics.failed;
    aggregate.deadLettered += metrics.deadLettered;
    aggregate.yielded += metrics.yielded;
    aggregate.jobs.push(...metrics.jobs);

    // A job checked itself back in because the run is out of time; claiming
    // another one would only repeat that.
    if (metrics.yielded > 0) {
      break;
    }

    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
      break;
    }

    if (metrics.claimed === 0) {
      logger.info("ingestion_worker_idle", {
        workerName: settings.workerName,
        pollIntervalSeconds: settings.workerPollIntervalSeconds,
      });
      if (maxJobs > 0) {
        break;
      }
      await sleep(settings.workerPollIntervalSeconds * 1000);
      continue;
    }

    processedBatches += metrics.claimed;
    if (maxJobs > 0 && processedBatches >= maxJobs) {
      break;
    }
  }

  aggregate.durationMs = Date.now() - startedAt;
  return aggregate;
}
