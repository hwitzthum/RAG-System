import {
  INGESTION_RUN_MAX_SECONDS,
  runIngestionTrigger,
  type IngestionTriggerDependencies,
} from "@/lib/ingestion/runtime/trigger";
import type { RuntimeLogger } from "@/lib/ingestion/runtime/types";

export type IngestionAutoKickDependencies = Partial<IngestionTriggerDependencies> & {
  schedule(task: () => void | Promise<void>): void;
};

export function scheduleIngestionAutoKick(input: {
  acceptedCount: number;
  cronSecret: string | undefined;
  region: string | null | undefined;
  /**
   * `Date.now()` at the start of the upload request. The scheduled run shares
   * that invocation's `maxDuration` window, so its deadline counts from here,
   * not from when the background task starts.
   */
  requestStartedAt: number;
  logger?: RuntimeLogger;
  dependencies?: Partial<IngestionAutoKickDependencies>;
}): boolean {
  const acceptedCount = Math.max(0, Math.floor(input.acceptedCount));
  if (!input.cronSecret || acceptedCount === 0) {
    return false;
  }

  const cronSecret = input.cronSecret;
  const schedule = input.dependencies?.schedule;
  if (!schedule) {
    throw new Error("scheduleIngestionAutoKick requires a schedule dependency");
  }

  const logger = input.dependencies?.logger ?? input.logger ?? console;
  const region = input.region ?? null;

  schedule(async () => {
    // Only the part of the run budget the upload itself did not use is left.
    // With none left, leave the jobs to the next cron tick: runIngestionTrigger
    // treats a non-positive budget as "no deadline", which is exactly the
    // mid-batch kill this bound exists to prevent.
    const maxRunSeconds =
      INGESTION_RUN_MAX_SECONDS - (Date.now() - input.requestStartedAt) / 1000;
    if (maxRunSeconds <= 0) {
      logger.warn("ingestion_auto_kick_skipped", {
        reason: "run_budget_exhausted",
        acceptedCount,
        region: input.region?.trim() || "unknown",
      });
      return;
    }

    const result = await (input.dependencies?.runWorker || input.dependencies?.assertRuntimeContract || input.dependencies?.logger
      ? runIngestionTrigger({
          cronSecret,
          bearerToken: cronSecret,
          region,
          maxJobs: acceptedCount,
          maxRunSeconds,
          dependencies: {
            assertRuntimeContract: input.dependencies?.assertRuntimeContract,
            runWorker: input.dependencies?.runWorker,
            logger: input.dependencies?.logger ?? logger,
          },
        })
      : runIngestionTrigger({
          cronSecret,
          bearerToken: cronSecret,
          region,
          maxJobs: acceptedCount,
          maxRunSeconds,
        }));

    if (result.statusCode === 500) {
      logger.error("ingestion_auto_kick_failed", {
        acceptedCount,
        region: input.region?.trim() || "unknown",
      });
    }
  });

  return true;
}
