import { runIngestionTrigger, type IngestionTriggerDependencies } from "@/lib/ingestion/runtime/trigger";
import type { RuntimeLogger } from "@/lib/ingestion/runtime/types";

export type IngestionAutoKickDependencies = Partial<IngestionTriggerDependencies> & {
  schedule(task: () => void | Promise<void>): void;
};

export function scheduleIngestionAutoKick(input: {
  acceptedCount: number;
  cronSecret: string | undefined;
  region: string | null | undefined;
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
    const result = await (input.dependencies?.runWorker || input.dependencies?.assertRuntimeContract || input.dependencies?.logger
      ? runIngestionTrigger({
          cronSecret,
          bearerToken: cronSecret,
          region,
          maxJobs: acceptedCount,
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
        }));

    if (result.statusCode === 500) {
      logger.error("ingestion_auto_kick_failed", {
        acceptedCount,
        region: input.region?.trim() || "unknown",
        message: result.body.message,
      });
    }
  });

  return true;
}
