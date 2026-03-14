import assert from "node:assert/strict";
import test from "node:test";
import {
  computeEmbeddingSnapshot,
  cosineDistance,
  evaluateEmbeddingDrift,
} from "../lib/retrieval/embedding-drift";

test("computeEmbeddingSnapshot summarizes norms and language stats", () => {
  const snapshot = computeEmbeddingSnapshot([
    { embedding: [1, 0, 0], language: "EN" },
    { embedding: [0, 1, 0], language: "EN" },
    { embedding: [0, 0, 1], language: "DE" },
  ]);

  assert.equal(snapshot.sampleCount, 3);
  assert.equal(snapshot.dimension, 3);
  assert.equal(snapshot.zeroVectorCount, 0);
  assert.equal(snapshot.languageStats.EN?.count, 2);
  assert.equal(snapshot.languageStats.DE?.count, 1);
});

test("cosineDistance detects identical and divergent centroids", () => {
  assert.equal(cosineDistance([1, 0], [1, 0]), 0);
  assert.equal(cosineDistance([1, 0], [0, 1]) > 0.9, true);
});

test("evaluateEmbeddingDrift passes stable snapshots", () => {
  const baseline = computeEmbeddingSnapshot([
    { embedding: [1, 0, 0], language: "EN" },
    { embedding: [0.9, 0.1, 0], language: "EN" },
    { embedding: [0, 1, 0], language: "DE" },
    { embedding: [0.05, 0.95, 0], language: "DE" },
  ]);

  const current = computeEmbeddingSnapshot([
    { embedding: [0.98, 0.02, 0], language: "EN" },
    { embedding: [0.88, 0.12, 0], language: "EN" },
    { embedding: [0.04, 0.96, 0], language: "DE" },
    { embedding: [0.1, 0.9, 0], language: "DE" },
  ]);

  const evaluation = evaluateEmbeddingDrift({
    current,
    baseline,
    thresholds: {
      minSamples: 4,
      minLanguageSamples: 2,
    },
  });

  assert.equal(evaluation.passed, true);
});

test("evaluateEmbeddingDrift flags strong centroid drift", () => {
  const baseline = computeEmbeddingSnapshot([
    { embedding: [1, 0, 0], language: "EN" },
    { embedding: [0.95, 0.05, 0], language: "EN" },
    { embedding: [0, 1, 0], language: "DE" },
    { embedding: [0.05, 0.95, 0], language: "DE" },
  ]);

  const current = computeEmbeddingSnapshot([
    { embedding: [0, 0, 1], language: "EN" },
    { embedding: [0.05, 0, 0.95], language: "EN" },
    { embedding: [0, 0, 1], language: "DE" },
    { embedding: [0, 0.05, 0.95], language: "DE" },
  ]);

  const evaluation = evaluateEmbeddingDrift({
    current,
    baseline,
    thresholds: {
      minSamples: 4,
      minLanguageSamples: 2,
    },
  });

  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.checks.some((check) => check.name === "centroid_drift_within_limit" && !check.passed), true);
});
