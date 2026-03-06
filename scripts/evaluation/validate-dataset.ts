#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { validateEvaluationDataset } from "../../lib/evaluation/dataset";

function parseArgs(argv: string[]): { datasetPath: string; minTotal: number; minPerLanguage: number } {
  let datasetPath = "evaluation/evaluation_queries.json";
  let minTotal = 200;
  let minPerLanguage = 40;

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dataset") {
      datasetPath = argv[index + 1] ?? datasetPath;
      index += 1;
    } else if (token === "--min-total") {
      minTotal = Number.parseInt(argv[index + 1] ?? `${minTotal}`, 10);
      index += 1;
    } else if (token === "--min-per-language") {
      minPerLanguage = Number.parseInt(argv[index + 1] ?? `${minPerLanguage}`, 10);
      index += 1;
    }
  }

  return { datasetPath, minTotal, minPerLanguage };
}

function run(): void {
  const args = parseArgs(process.argv);
  const resolvedPath = path.resolve(args.datasetPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Dataset file not found: ${resolvedPath}`);
  }

  const parsedJson = JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as unknown;
  const result = validateEvaluationDataset(parsedJson, {
    minTotalQueries: args.minTotal,
    minPerLanguage: args.minPerLanguage,
  });

  console.log(`Evaluation dataset validation passed: ${resolvedPath}`);
  console.log(`Total queries: ${result.totalQueries}`);
  console.log(
    `Language counts: EN=${result.languageCounts.EN}, DE=${result.languageCounts.DE}, FR=${result.languageCounts.FR}, IT=${result.languageCounts.IT}, ES=${result.languageCounts.ES}`,
  );
}

run();

