#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { LangfuseClient } from "@langfuse/client";
import { validateEvaluationDataset } from "../../lib/evaluation/dataset";
import { datasetNameForFingerprint } from "../../lib/evaluation/langfuse-dataset";

/**
 * Mirrors the local golden set into Langfuse Datasets.
 *
 * The JSON file stays the source of truth — it is regenerated from the corpus
 * and read by the release gate, which must stay local and deterministic. This
 * mirror exists so that benchmark runs become comparable in the Langfuse UI and
 * a metric can be traced back to the retrieval that produced it.
 *
 * Safe to re-run: dataset items are upserted on their id, so re-syncing an
 * unchanged golden set is a no-op.
 */

const DATASET_PATH = "evaluation/evaluation_queries.generated.json";

function parseArgs(argv: string[]): { datasetPath: string } {
  const datasetPathIndex = argv.indexOf("--dataset");
  return {
    datasetPath:
      datasetPathIndex >= 0
        ? (argv[datasetPathIndex + 1] ?? DATASET_PATH)
        : DATASET_PATH,
  };
}

async function main(): Promise<void> {
  const { datasetPath } = parseArgs(process.argv);

  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    throw new Error(
      "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set to sync the dataset.",
    );
  }

  const resolved = path.resolve(datasetPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Dataset file not found: ${resolved}`);
  }

  const raw = JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
  // Validated with the same floors the benchmark uses, so a golden set that
  // could not gate a release can never be published as one either.
  const validated = validateEvaluationDataset(raw, {
    minTotalQueries: 25,
    minPerLanguage: 5,
  });

  // Guaranteed present by the schema — the golden set cannot validate without
  // a fingerprint, which is what makes the dataset name meaningful.
  const fingerprint = validated.corpusFingerprint;
  const name = datasetNameForFingerprint(fingerprint);
  const langfuse = new LangfuseClient();

  await langfuse.api.datasets.create({
    name,
    description:
      `Corpus-derived golden set, ${validated.records.length} records. ` +
      `Source of truth is ${datasetPath} in the repository; this is a mirror for run comparison.`,
    metadata: {
      corpusFingerprint: fingerprint,
      generatedAt: validated.generatedAt,
      generatorModel: validated.generatorModel,
      recordCount: validated.records.length,
      sourcePath: datasetPath,
    },
  });
  console.log(`dataset  ${name} (${validated.records.length} records)`);

  let synced = 0;
  for (const record of validated.records) {
    await langfuse.dataset.createItem({
      datasetName: name,
      // The record id is the item id, so re-syncing updates in place rather
      // than duplicating. Ids are stable within a corpus fingerprint.
      id: record.id,
      input: { question: record.question },
      expectedOutput: {
        expected_chunk_ids: record.expected_chunk_ids,
        expected_document: record.expected_document,
        expected_section: record.expected_section,
        expected_pages: record.expected_pages,
        acceptable_answer_points: record.acceptable_answer_points,
      },
      metadata: {
        language: record.language,
        question_type: record.question_type,
        corpusFingerprint: fingerprint,
      },
    });
    synced += 1;
  }

  console.log(`items    ${synced} upserted`);
  console.log(
    `\nRun the benchmark to populate this dataset: npm run eval:benchmark`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Dataset sync failed: ${message}`);
  process.exitCode = 1;
});
