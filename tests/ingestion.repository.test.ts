import assert from "node:assert/strict";
import test from "node:test";
import { resolveIngestionRuntimeSettings } from "../lib/ingestion/runtime/types";

const quietLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY ??= "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-key";
process.env.OPENAI_API_KEY ??= "test-openai-key";

async function createRepositoryWithRpcError(message: string) {
  const { SupabaseIngestionRuntimeRepository } = await import("../lib/ingestion/runtime/repository");
  const supabase = {
    async rpc() {
      return {
        data: null,
        error: { message },
      };
    },
  };

  return new SupabaseIngestionRuntimeRepository({
    settings: resolveIngestionRuntimeSettings(),
    logger: quietLogger,
    supabase: supabase as never,
  });
}

test("claimIngestionJobs throws when the claim RPC is unavailable", async () => {
  const repository = await createRepositoryWithRpcError("Could not find the function public.claim_ingestion_jobs");

  await assert.rejects(
    repository.claimIngestionJobs({
      workerName: "worker-1",
      batchSize: 1,
      lockTimeoutSeconds: 60,
      maxRetries: 3,
    }),
    /Required ingestion RPC claim_ingestion_jobs is unavailable/,
  );
});

test("markJobCompleted throws when the completion RPC is unavailable", async () => {
  const repository = await createRepositoryWithRpcError("Could not find the function public.complete_ingestion_job");

  await assert.rejects(
    repository.markJobCompleted("job-1", "EN"),
    /Required ingestion RPC complete_ingestion_job is unavailable/,
  );
});

test("markJobFailed throws when the failure RPC is unavailable", async () => {
  const repository = await createRepositoryWithRpcError("Could not find the function public.fail_ingestion_job");

  await assert.rejects(
    repository.markJobFailed(
      {
        id: "job-1",
        documentId: "doc-1",
        status: "processing",
        attempt: 1,
      },
      "boom",
    ),
    /Required ingestion RPC fail_ingestion_job is unavailable/,
  );
});

test("saveChunkCandidates throws when the checkpoint RPC is unavailable", async () => {
  const repository = await createRepositoryWithRpcError("Could not find the function public.checkpoint_ingestion_job");

  await assert.rejects(
    repository.saveChunkCandidates("job-1", [], 0),
    /Required ingestion RPC checkpoint_ingestion_job is unavailable/,
  );
});

test("replaceDocumentChunks throws when the chunk replacement RPC is unavailable", async () => {
  const repository = await createRepositoryWithRpcError("Could not find the function public.replace_document_chunks");

  await assert.rejects(
    repository.replaceDocumentChunks("doc-1", []),
    /Required ingestion RPC replace_document_chunks is unavailable/,
  );
});

test("insertChunkBatch throws when the chunk append RPC is unavailable", async () => {
  const repository = await createRepositoryWithRpcError("Could not find the function public.append_document_chunks");

  await assert.rejects(
    repository.insertChunkBatch("doc-1", [
      {
        documentId: "doc-1",
        chunkIndex: 0,
        pageNumber: 1,
        sectionTitle: "Section",
        content: "Content",
        context: "Context",
        language: "EN",
        embedding: [0],
      },
    ]),
    /Required ingestion RPC append_document_chunks is unavailable/,
  );
});

test("invalidateRetrievalCache throws when the cache invalidation RPC is unavailable", async () => {
  const repository = await createRepositoryWithRpcError("Could not find the function public.invalidate_retrieval_cache");

  await assert.rejects(
    repository.invalidateRetrievalCache(),
    /Required ingestion RPC invalidate_retrieval_cache is unavailable/,
  );
});

test("updateJobProgress throws when the checkpoint RPC is unavailable", async () => {
  const repository = await createRepositoryWithRpcError("Could not find the function public.checkpoint_ingestion_job");

  await assert.rejects(
    repository.updateJobProgress("job-1", 3),
    /Required ingestion RPC checkpoint_ingestion_job is unavailable/,
  );
});

test("yieldJob throws when the yield RPC is unavailable", async () => {
  const repository = await createRepositoryWithRpcError("Could not find the function public.yield_ingestion_job");

  await assert.rejects(
    repository.yieldJob("job-1"),
    /Required ingestion RPC yield_ingestion_job is unavailable/,
  );
});

test("updateJobStage throws when the checkpoint RPC is unavailable", async () => {
  const repository = await createRepositoryWithRpcError("Could not find the function public.checkpoint_ingestion_job");

  await assert.rejects(
    repository.updateJobStage("job-1", "embedding"),
    /Required ingestion RPC checkpoint_ingestion_job is unavailable/,
  );
});
