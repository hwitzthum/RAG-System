import assert from "node:assert/strict";
import test from "node:test";
import { scheduleIngestionAutoKick } from "../lib/ingestion/runtime/auto-kick";
import { INGESTION_RUN_MAX_SECONDS } from "../lib/ingestion/runtime/trigger";

test("scheduleIngestionAutoKick is a no-op when cron secret is unavailable", () => {
  const scheduledTasks: Array<() => void | Promise<void>> = [];

  const scheduled = scheduleIngestionAutoKick({
    acceptedCount: 1,
    cronSecret: undefined,
    region: "fra1",
    requestStartedAt: Date.now(),
    dependencies: {
      schedule(task) {
        scheduledTasks.push(task);
      },
    },
  });

  assert.equal(scheduled, false);
  assert.equal(scheduledTasks.length, 0);
});

test("scheduleIngestionAutoKick schedules a trigger run for accepted uploads", async () => {
  const scheduledTasks: Array<() => void | Promise<void>> = [];
  const workerCalls: Array<Record<string, unknown>> = [];

  const scheduled = scheduleIngestionAutoKick({
    acceptedCount: 3,
    cronSecret: "expected-secret",
    region: "fra1",
    requestStartedAt: Date.now(),
    dependencies: {
      schedule(task) {
        scheduledTasks.push(task);
      },
      assertRuntimeContract: async () => undefined,
      runWorker: async (input) => {
        workerCalls.push({
          workerName: input.settings?.workerName,
          maxJobs: input.maxJobs,
        });

        return {
          claimed: 3,
          completed: 3,
          failed: 0,
          deadLettered: 0,
      yielded: 0,
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

  assert.equal(scheduled, true);
  assert.equal(scheduledTasks.length, 1);
  await scheduledTasks[0]?.();

  assert.deepEqual(workerCalls, [
    {
      workerName: "ingestion-trigger-fra1",
      maxJobs: 3,
    },
  ]);
});

test("scheduleIngestionAutoKick logs failures from the background trigger", async () => {
  const scheduledTasks: Array<() => void | Promise<void>> = [];
  const errors: Array<Record<string, unknown>> = [];

  scheduleIngestionAutoKick({
    acceptedCount: 2,
    cronSecret: "expected-secret",
    region: "iad1",
    requestStartedAt: Date.now(),
    dependencies: {
      schedule(task) {
        scheduledTasks.push(task);
      },
      assertRuntimeContract: async () => {
        throw new Error("Missing required ingestion RPCs: claim_ingestion_jobs");
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

  await scheduledTasks[0]?.();

  assert.equal(errors.length, 2);
  assert.equal(errors[0]?.event, "ingestion_trigger_failed");
  assert.equal(errors[1]?.event, "ingestion_auto_kick_failed");
});

test("scheduleIngestionAutoKick bounds the run by the budget left since the request started", async () => {
  const scheduledTasks: Array<() => void | Promise<void>> = [];
  const deadlines: Array<number | undefined> = [];
  const requestStartedAt = Date.now() - 30_000;

  scheduleIngestionAutoKick({
    acceptedCount: 1,
    cronSecret: "expected-secret",
    region: "fra1",
    requestStartedAt,
    dependencies: {
      schedule(task) {
        scheduledTasks.push(task);
      },
      assertRuntimeContract: async () => undefined,
      runWorker: async (input) => {
        deadlines.push(input.deadlineAt);
        return {
          claimed: 1,
          completed: 1,
          failed: 0,
          deadLettered: 0,
          yielded: 0,
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

  await scheduledTasks[0]?.();

  const expectedDeadline = requestStartedAt + INGESTION_RUN_MAX_SECONDS * 1000;
  assert.equal(deadlines.length, 1);
  const deadlineAt = deadlines[0];
  assert.ok(
    deadlineAt !== undefined && Math.abs(deadlineAt - expectedDeadline) < 1_000,
    `deadlineAt ${deadlineAt} should be ~${expectedDeadline}`,
  );
});

test("scheduleIngestionAutoKick skips the run when the upload already used the budget", async () => {
  const scheduledTasks: Array<() => void | Promise<void>> = [];
  let workerRuns = 0;
  const warnings: string[] = [];

  const scheduled = scheduleIngestionAutoKick({
    acceptedCount: 1,
    cronSecret: "expected-secret",
    region: "fra1",
    requestStartedAt: Date.now() - (INGESTION_RUN_MAX_SECONDS + 1) * 1000,
    dependencies: {
      schedule(task) {
        scheduledTasks.push(task);
      },
      assertRuntimeContract: async () => undefined,
      runWorker: async () => {
        workerRuns += 1;
        return {
          claimed: 0,
          completed: 0,
          failed: 0,
          deadLettered: 0,
          yielded: 0,
          durationMs: 0,
          jobs: [],
        };
      },
      logger: {
        info() {},
        warn(event) {
          warnings.push(event);
        },
        error() {},
      },
    },
  });

  assert.equal(scheduled, true);
  await scheduledTasks[0]?.();

  assert.equal(workerRuns, 0);
  assert.deepEqual(warnings, ["ingestion_auto_kick_skipped"]);
});
