import assert from "node:assert/strict";
import test from "node:test";
import { assertRequiredIngestionRpcsAvailable, REQUIRED_INGESTION_RPCS } from "../lib/ingestion/runtime/contract";

test("assertRequiredIngestionRpcsAvailable passes when all required RPCs exist", async () => {
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
    async runSmokeTestIngestionRuntimeContractRpc() {
      return {
        data: [{ check_name: "smoke", detail: "ok" }],
        error: null,
      };
    },
  };

  await assert.doesNotReject(
    assertRequiredIngestionRpcsAvailable({
      client,
    }),
  );
});

test("assertRequiredIngestionRpcsAvailable throws with the missing RPC names", async () => {
  const client = {
    async runCheckRequiredIngestionRpcsRpc() {
      return {
        data: REQUIRED_INGESTION_RPCS.filter((name) => name !== "reconcile_document_status").map((function_name) => ({
          function_name,
          is_present: true,
        })),
        error: null,
      };
    },
    async runSmokeTestIngestionRuntimeContractRpc() {
      return {
        data: [{ check_name: "smoke", detail: "ok" }],
        error: null,
      };
    },
  };

  await assert.rejects(
    assertRequiredIngestionRpcsAvailable({
      client,
    }),
    /Missing required ingestion RPCs: reconcile_document_status/,
  );
});

test("assertRequiredIngestionRpcsAvailable throws when the contract check RPC is unavailable", async () => {
  const client = {
    async runCheckRequiredIngestionRpcsRpc() {
      return {
        data: null,
        error: {
          message: "Could not find the function public.check_required_ingestion_rpcs",
        },
      };
    },
    async runSmokeTestIngestionRuntimeContractRpc() {
      return {
        data: null,
        error: null,
      };
    },
  };

  await assert.rejects(
    assertRequiredIngestionRpcsAvailable({
      client,
    }),
    /Required ingestion RPC check_required_ingestion_rpcs is unavailable/,
  );
});

test("assertRequiredIngestionRpcsAvailable throws when the runtime smoke check RPC is unavailable", async () => {
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
    async runSmokeTestIngestionRuntimeContractRpc() {
      return {
        data: null,
        error: {
          message: "Could not find the function public.smoke_test_ingestion_runtime_contract",
        },
      };
    },
  };

  await assert.rejects(
    assertRequiredIngestionRpcsAvailable({
      client,
    }),
    /Required ingestion RPC smoke_test_ingestion_runtime_contract is unavailable/,
  );
});

test("assertRequiredIngestionRpcsAvailable throws when the runtime smoke check fails", async () => {
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
    async runSmokeTestIngestionRuntimeContractRpc() {
      return {
        data: null,
        error: {
          message: "claim_ingestion_jobs did not claim the smoke test job",
        },
      };
    },
  };

  await assert.rejects(
    assertRequiredIngestionRpcsAvailable({
      client,
    }),
    /Ingestion runtime smoke check failed: claim_ingestion_jobs did not claim the smoke test job/,
  );
});
