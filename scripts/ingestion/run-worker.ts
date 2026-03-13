#!/usr/bin/env node

import { assertRequiredIngestionRpcsAvailable } from "@/lib/ingestion/runtime/contract";
import { runIngestionWorker } from "@/lib/ingestion/runtime/worker-loop";
import { resolveIngestionRuntimeSettings } from "@/lib/ingestion/runtime/types";

type WorkerCliArgs = {
  once: boolean;
  maxJobs: number;
};

function parseArgs(argv: string[]): WorkerCliArgs {
  const args: WorkerCliArgs = {
    once: false,
    maxJobs: 0,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--once") {
      args.once = true;
      continue;
    }
    if (token === "--max-jobs") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      args.maxJobs = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
      index += 1;
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const settings = resolveIngestionRuntimeSettings();

  console.info("ingestion_worker_starting", {
    workerName: settings.workerName,
    pollIntervalSeconds: settings.workerPollIntervalSeconds,
    maxRetries: settings.maxRetries,
    chunkTargetTokens: settings.chunkTargetTokens,
    chunkOverlapTokens: settings.chunkOverlapTokens,
    chunksPerRun: settings.chunksPerRun,
    embeddingModel: settings.embeddingModel,
    contextEnabled: settings.contextEnabled,
  });

  await assertRequiredIngestionRpcsAvailable();

  const metrics = await runIngestionWorker({
    settings,
    logger: console,
    maxJobs: args.once ? 1 : args.maxJobs,
  });

  console.info("ingestion_worker_stopped", metrics);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("ingestion_worker_fatal", { message });
  process.exit(1);
});
