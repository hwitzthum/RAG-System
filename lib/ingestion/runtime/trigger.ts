import { createHash, timingSafeEqual } from "node:crypto";
import { assertRequiredIngestionRpcsAvailable } from "@/lib/ingestion/runtime/contract";
import { runIngestionWorker, type IngestionWorkerLoopInput } from "@/lib/ingestion/runtime/worker-loop";
import { resolveIngestionRuntimeSettings, type RuntimeLogger } from "@/lib/ingestion/runtime/types";

export type IngestionTriggerDependencies = {
  assertRuntimeContract(): Promise<void>;
  runWorker(input: IngestionWorkerLoopInput): ReturnType<typeof runIngestionWorker>;
  logger: RuntimeLogger;
};

export function isIngestionTriggerAuthorized(input: {
  cronSecret: string | undefined;
  bearerToken: string | null;
}): boolean {
  if (!input.cronSecret || !input.bearerToken) {
    return false;
  }

  const providedDigest = createHash("sha256").update(input.bearerToken, "utf8").digest();
  const expectedDigest = createHash("sha256").update(input.cronSecret, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export async function runIngestionTrigger(input: {
  cronSecret: string | undefined;
  bearerToken: string | null;
  region: string | null | undefined;
  maxJobs?: number;
  /**
   * Seconds of this invocation's window the run may use before checking a
   * still-unfinished job back into the queue. Leaves room for the in-flight
   * batch to land, so the platform never kills the function mid-batch.
   */
  maxRunSeconds?: number;
  dependencies?: Partial<IngestionTriggerDependencies>;
}): Promise<
  | { statusCode: 401; body: { error: "Unauthorized" } }
  | {
      statusCode: 200;
      body: {
        status: "idle" | "processed";
        claimed: number;
        yielded: number;
      };
    }
  | { statusCode: 500; body: { error: "Failed to run ingestion batch" } }
> {
  if (
    !isIngestionTriggerAuthorized({
      cronSecret: input.cronSecret,
      bearerToken: input.bearerToken,
    })
  ) {
    return {
      statusCode: 401,
      body: { error: "Unauthorized" },
    };
  }

  const dependencies: IngestionTriggerDependencies = {
    assertRuntimeContract: input.dependencies?.assertRuntimeContract ?? (() => assertRequiredIngestionRpcsAvailable()),
    runWorker: input.dependencies?.runWorker ?? runIngestionWorker,
    logger: input.dependencies?.logger ?? console,
  };

  const settings = resolveIngestionRuntimeSettings({
    workerName: `ingestion-trigger-${input.region?.trim() || "unknown"}`,
  });
  const maxJobs = Math.max(1, Math.min(50, Math.floor(input.maxJobs ?? 1)));
  const deadlineAt =
    input.maxRunSeconds !== undefined && input.maxRunSeconds > 0
      ? Date.now() + input.maxRunSeconds * 1000
      : undefined;

  try {
    await dependencies.assertRuntimeContract();
    const metrics = await dependencies.runWorker({
      settings,
      logger: dependencies.logger,
      maxJobs,
      deadlineAt,
    });

    return {
      statusCode: 200,
      body: {
        status: metrics.claimed === 0 ? "idle" : "processed",
        claimed: metrics.claimed,
        yielded: metrics.yielded,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    dependencies.logger.error("ingestion_trigger_failed", {
      message,
      region: input.region?.trim() || "unknown",
    });

    return {
      statusCode: 500,
      body: {
        error: "Failed to run ingestion batch",
      },
    };
  }
}
