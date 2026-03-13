import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRequiredRetrievalCacheRpcsAvailable,
  REQUIRED_RETRIEVAL_CACHE_RPCS,
} from "../lib/retrieval/cache-contract";

test("assertRequiredRetrievalCacheRpcsAvailable passes when all required RPCs exist", async () => {
  const client = {
    async runCheckRequiredIngestionRpcsRpc(args: { required_functions?: string[] }) {
      return {
        data: (args.required_functions ?? []).map((function_name) => ({
          function_name,
          is_present: true,
        })),
        error: null,
      };
    },
  };

  await assert.doesNotReject(
    assertRequiredRetrievalCacheRpcsAvailable({
      client,
    }),
  );
});

test("assertRequiredRetrievalCacheRpcsAvailable throws with the missing RPC names", async () => {
  const client = {
    async runCheckRequiredIngestionRpcsRpc() {
      return {
        data: REQUIRED_RETRIEVAL_CACHE_RPCS.filter((name) => name !== "touch_retrieval_cache_entry").map(
          (function_name) => ({
            function_name,
            is_present: true,
          }),
        ),
        error: null,
      };
    },
  };

  await assert.rejects(
    assertRequiredRetrievalCacheRpcsAvailable({
      client,
    }),
    /Missing required retrieval cache RPCs: touch_retrieval_cache_entry/,
  );
});

test("assertRequiredRetrievalCacheRpcsAvailable throws when the contract check RPC is unavailable", async () => {
  const client = {
    async runCheckRequiredIngestionRpcsRpc() {
      return {
        data: null,
        error: {
          message: "Could not find the function public.check_required_ingestion_rpcs",
        },
      };
    },
  };

  await assert.rejects(
    assertRequiredRetrievalCacheRpcsAvailable({
      client,
    }),
    /Required retrieval cache RPC check_required_ingestion_rpcs is unavailable/,
  );
});
