import assert from "node:assert/strict";
import test from "node:test";
import { collectMeasuredProcessingDurations, computeP95 } from "../lib/ingestion/runtime/soak-metrics";

test("collectMeasuredProcessingDurations ignores null and invalid values", () => {
  const values = collectMeasuredProcessingDurations([
    { processing_duration_ms: 1200 },
    { processing_duration_ms: null },
    { processing_duration_ms: -4 },
    { processing_duration_ms: Number.NaN },
    { processing_duration_ms: 800 },
  ]);

  assert.deepEqual(values, [1200, 800]);
});

test("computeP95 returns the 95th percentile value", () => {
  const value = computeP95([100, 200, 300, 400, 500]);
  assert.equal(value, 500);
});

test("computeP95 returns null for an empty input set", () => {
  assert.equal(computeP95([]), null);
});
