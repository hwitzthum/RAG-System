import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Static analysis tests that verify API route modules export the correct
 * `maxDuration` and `runtime` segment config values. Uses file content
 * matching rather than dynamic import to avoid env validation side effects.
 *
 * These are critical for Vercel serverless function behavior — without
 * maxDuration, long-running routes hit the default 15s timeout on Pro.
 */

interface RouteConfig {
  path: string;
  filePath: string;
  expectedMaxDuration: number;
  expectedRuntime: string;
}

const routesWithMaxDuration: RouteConfig[] = [
  {
    path: "/api/query",
    filePath: "app/api/query/route.ts",
    expectedMaxDuration: 120,
    expectedRuntime: "nodejs",
  },
  {
    path: "/api/reports",
    filePath: "app/api/reports/route.ts",
    expectedMaxDuration: 60,
    expectedRuntime: "nodejs",
  },
  {
    path: "/api/documents/[id]",
    filePath: "app/api/documents/[id]/route.ts",
    expectedMaxDuration: 30,
    expectedRuntime: "nodejs",
  },
  {
    path: "/api/upload",
    filePath: "app/api/upload/route.ts",
    expectedMaxDuration: 120,
    expectedRuntime: "nodejs",
  },
  {
    path: "/api/upload/batch",
    filePath: "app/api/upload/batch/route.ts",
    expectedMaxDuration: 120,
    expectedRuntime: "nodejs",
  },
  {
    path: "/api/internal/ingestion/run",
    filePath: "app/api/internal/ingestion/run/route.ts",
    expectedMaxDuration: 120,
    expectedRuntime: "nodejs",
  },
  {
    path: "/api/internal/observability/metrics",
    filePath: "app/api/internal/observability/metrics/route.ts",
    expectedMaxDuration: 15,
    expectedRuntime: "nodejs",
  },
];

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readRoute(filePath: string): string {
  return readFileSync(resolve(projectRoot, filePath), "utf-8");
}

function extractExportedConst(source: string, name: string): string | undefined {
  const match = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(.+?)\\s*;`));
  return match?.[1]?.replace(/['"]/g, "");
}

for (const route of routesWithMaxDuration) {
  test(`${route.path} exports maxDuration = ${route.expectedMaxDuration}`, () => {
    const source = readRoute(route.filePath);
    const value = extractExportedConst(source, "maxDuration");
    assert.ok(value !== undefined, `${route.path} must export maxDuration`);
    assert.equal(
      Number(value),
      route.expectedMaxDuration,
      `${route.path} maxDuration should be ${route.expectedMaxDuration}, got ${value}`,
    );
  });

  test(`${route.path} exports runtime = "${route.expectedRuntime}"`, () => {
    const source = readRoute(route.filePath);
    const value = extractExportedConst(source, "runtime");
    assert.ok(value !== undefined, `${route.path} must export runtime`);
    assert.equal(
      value,
      route.expectedRuntime,
      `${route.path} runtime should be "${route.expectedRuntime}", got "${value}"`,
    );
  });
}