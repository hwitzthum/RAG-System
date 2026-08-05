#!/usr/bin/env tsx

// Derives RAG_EVIDENCE_SUFFICIENT_TOP3_MEAN from a stored benchmark artifact:
//   tsx scripts/evaluation/calibrate-evidence-thresholds.ts <artifact.json>
//
// Read-only file analysis — no environment is loaded and nothing is written.
// The recommendation separates the unanswerable slice's top-3-mean relevance
// from the answerable slice's; if the two overlap there is no honest
// threshold and the script hard-fails rather than shipping one.

import fs from "node:fs";
import path from "node:path";
import type { QueryBenchmarkResult } from "../../lib/evaluation/types";

type BenchmarkArtifact = {
  results?: QueryBenchmarkResult[];
};

type QueryStats = {
  id: string;
  top1: number;
  top3Mean: number;
};

function parseArgs(argv: string[]): { artifactPath: string } {
  const artifactPath = argv[2];
  if (!artifactPath) {
    throw new Error(
      "Usage: tsx scripts/evaluation/calibrate-evidence-thresholds.ts <artifact.json>",
    );
  }
  return { artifactPath };
}

function quantile(sortedValues: number[], q: number): number {
  const position = (sortedValues.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sortedValues[lower]! * (1 - weight) + sortedValues[upper]! * weight;
}

function formatValue(value: number): string {
  return value.toFixed(3);
}

function printSliceTable(label: string, stats: QueryStats[]): void {
  console.log(`\n${label} (${stats.length} queries)`);
  if (stats.length === 0) {
    console.log("  (empty slice)");
    return;
  }
  console.log(
    "  stat      |   min |   p25 |   p50 |   p75 |   p90 |   max |  mean",
  );
  for (const [name, values] of [
    ["top1", stats.map((entry) => entry.top1)],
    ["top3mean", stats.map((entry) => entry.top3Mean)],
  ] as const) {
    const sorted = [...values].sort((a, b) => a - b);
    const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
    const row = [
      sorted[0]!,
      quantile(sorted, 0.25),
      quantile(sorted, 0.5),
      quantile(sorted, 0.75),
      quantile(sorted, 0.9),
      sorted[sorted.length - 1]!,
      mean,
    ]
      .map(formatValue)
      .join(" | ");
    console.log(`  ${name.padEnd(9)} | ${row}`);
  }
}

function run(): void {
  const args = parseArgs(process.argv);
  const resolvedPath = path.resolve(args.artifactPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Artifact file not found: ${resolvedPath}`);
  }

  const artifact = JSON.parse(
    fs.readFileSync(resolvedPath, "utf8"),
  ) as BenchmarkArtifact;
  if (!Array.isArray(artifact.results) || artifact.results.length === 0) {
    throw new Error(
      "Artifact carries no results array — pass a benchmark run artifact from evaluation/runs/.",
    );
  }

  // The thresholds live on the cross-encoder scale, so every query must have
  // been scored by the cross-encoder. A "heuristic" or "mixed" composition
  // means the Cohere fallback fired mid-run; "unknown" means the artifact
  // predates the Wave 4.1 score instrumentation or the query errored.
  const contaminated = artifact.results.filter(
    (result) => result.retrieval.scoreScaleComposition !== "cross_encoder",
  );
  if (contaminated.length > 0) {
    throw new Error(
      `Refusing to calibrate: ${contaminated.length} query(ies) have a ` +
        `scoreScaleComposition other than "cross_encoder" ` +
        `(${contaminated
          .slice(0, 5)
          .map(
            (result) =>
              `${result.id}=${result.retrieval.scoreScaleComposition}`,
          )
          .join(", ")}${contaminated.length > 5 ? ", …" : ""}). ` +
        "Re-run the benchmark with a healthy cross-encoder before calibrating.",
    );
  }

  const answerable: QueryStats[] = [];
  const unanswerableAbstained: QueryStats[] = [];
  const unanswerableAnswered: QueryStats[] = [];

  for (const result of artifact.results) {
    const chunks = result.retrieval.chunks;
    for (const chunk of chunks) {
      if (typeof chunk.relevanceScore !== "number" || !chunk.scoreScale) {
        throw new Error(
          `Query ${result.id}: chunk ${chunk.chunkId} carries no ` +
            "relevanceScore/scoreScale — the artifact predates the Wave 4.1 " +
            "score instrumentation. Re-run the benchmark first.",
        );
      }
    }

    const top = chunks.slice(0, Math.min(3, chunks.length));
    const stats: QueryStats = {
      id: result.id,
      top1: chunks[0]!.relevanceScore!,
      top3Mean:
        top.reduce((sum, chunk) => sum + chunk.relevanceScore!, 0) / top.length,
    };

    if (result.questionType === "unanswerable") {
      (result.answer.insufficientEvidence
        ? unanswerableAbstained
        : unanswerableAnswered
      ).push(stats);
    } else {
      answerable.push(stats);
    }
  }

  console.log(`Artifact: ${resolvedPath}`);
  console.log(`Queries: ${artifact.results.length}`);
  printSliceTable("Unanswerable, abstained", unanswerableAbstained);
  printSliceTable(
    "Unanswerable, answered (false answers)",
    unanswerableAnswered,
  );
  printSliceTable("Answerable", answerable);

  const unanswerableTop3 = [
    ...unanswerableAbstained,
    ...unanswerableAnswered,
  ].map((entry) => entry.top3Mean);
  const answerableTop3 = answerable.map((entry) => entry.top3Mean);

  if (unanswerableTop3.length === 0 || answerableTop3.length === 0) {
    throw new Error(
      "Cannot calibrate: the artifact needs both answerable and unanswerable queries.",
    );
  }

  const maxUnanswerable = Math.max(...unanswerableTop3);
  const minAnswerable = Math.min(...answerableTop3);

  if (maxUnanswerable >= minAnswerable) {
    throw new Error(
      `Slices overlap: max(unanswerable top3mean) = ${formatValue(maxUnanswerable)} ` +
        `>= min(answerable top3mean) = ${formatValue(minAnswerable)}. ` +
        "No top-3-mean threshold separates false answers from real ones on " +
        "this artifact — do NOT ship a threshold; fix retrieval ordering " +
        "first or gate on a different signal.",
    );
  }

  const recommended = Math.min(maxUnanswerable + 0.02, minAnswerable - 0.01);
  console.log(
    `\nRecommended RAG_EVIDENCE_SUFFICIENT_TOP3_MEAN = ${formatValue(recommended)}`,
  );
  console.log(
    `  (max unanswerable ${formatValue(maxUnanswerable)} + 0.02, clamped to ` +
      `min answerable ${formatValue(minAnswerable)} - 0.01)`,
  );
}

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Calibration failed: ${message}`);
  process.exit(1);
}
