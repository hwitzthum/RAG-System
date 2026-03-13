import assert from "node:assert/strict";
import test from "node:test";
import { runIngestionTrigger, isIngestionTriggerAuthorized } from "../lib/ingestion/runtime/trigger";

test("isIngestionTriggerAuthorized rejects missing inputs", () => {
  assert.equal(
    isIngestionTriggerAuthorized({
      cronSecret: undefined,
      bearerToken: "secret",
    }),
    false,
  );

  assert.equal(
    isIngestionTriggerAuthorized({
      cronSecret: "secret",
      bearerToken: null,
    }),
    false,
  );
});

test("runIngestionTrigger rejects unauthorized requests", async () => {
  const result = await runIngestionTrigger({
    cronSecret: "expected-secret",
    bearerToken: "wrong-secret",
    region: "fra1",
  });

  assert.deepEqual(result, {
    statusCode: 401,
    body: {
      error: "Unauthorized",
    },
  });
});

test("runIngestionTrigger runs a single worker pass and returns processed status", async () => {
  const workerCalls: Array<Record<string, unknown>> = [];

  const result = await runIngestionTrigger({
    cronSecret: "expected-secret",
    bearerToken: "expected-secret",
    region: "fra1",
    dependencies: {
      assertRuntimeContract: async () => undefined,
      runWorker: async (input) => {
        workerCalls.push({
          workerName: input.settings?.workerName,
          maxJobs: input.maxJobs,
        });

        return {
          claimed: 1,
          completed: 1,
          failed: 0,
          deadLettered: 0,
          durationMs: 5,
          jobs: [],
        };
      },
      logger: {
        info() {},
        warn() {},
        error() {},
      },
    },
  });

  assert.deepEqual(workerCalls, [
    {
      workerName: "ingestion-trigger-fra1",
      maxJobs: 1,
    },
  ]);
  assert.deepEqual(result, {
    statusCode: 200,
    body: {
      status: "processed",
      claimed: 1,
    },
  });
});

test("runIngestionTrigger returns idle when no jobs are claimed", async () => {
  const result = await runIngestionTrigger({
    cronSecret: "expected-secret",
    bearerToken: "expected-secret",
    region: "iad1",
    dependencies: {
      assertRuntimeContract: async () => undefined,
      runWorker: async () => ({
        claimed: 0,
        completed: 0,
        failed: 0,
        deadLettered: 0,
        durationMs: 3,
        jobs: [],
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
      },
    },
  });

  assert.deepEqual(result, {
    statusCode: 200,
    body: {
      status: "idle",
      claimed: 0,
    },
  });
});

test("runIngestionTrigger returns failure details when the worker throws", async () => {
  const errors: Array<Record<string, unknown>> = [];

  const result = await runIngestionTrigger({
    cronSecret: "expected-secret",
    bearerToken: "expected-secret",
    region: "fra1",
    dependencies: {
      assertRuntimeContract: async () => undefined,
      runWorker: async () => {
        throw new Error("boom");
      },
      logger: {
        info() {},
        warn() {},
        error(event, payload) {
          errors.push({ event, payload });
        },
      },
    },
  });

  assert.deepEqual(result, {
    statusCode: 500,
    body: {
      error: "Failed to run ingestion batch",
      message: "boom",
    },
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.event, "ingestion_trigger_failed");
});

test("runIngestionTrigger returns failure details when the runtime contract check fails", async () => {
  const errors: Array<Record<string, unknown>> = [];

  const result = await runIngestionTrigger({
    cronSecret: "expected-secret",
    bearerToken: "expected-secret",
    region: "fra1",
    dependencies: {
      assertRuntimeContract: async () => {
        throw new Error("Missing required ingestion RPCs: fail_ingestion_job");
      },
      runWorker: async () => {
        throw new Error("worker should not run");
      },
      logger: {
        info() {},
        warn() {},
        error(event, payload) {
          errors.push({ event, payload });
        },
      },
    },
  });

  assert.deepEqual(result, {
    statusCode: 500,
    body: {
      error: "Failed to run ingestion batch",
      message: "Missing required ingestion RPCs: fail_ingestion_job",
    },
  });
  assert.equal(errors[0]?.event, "ingestion_trigger_failed");
});
