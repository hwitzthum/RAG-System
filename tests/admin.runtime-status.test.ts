import assert from "node:assert/strict";
import test from "node:test";

function ensureRuntimeStatusEnv(): void {
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY ??= "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-key";
  process.env.OPENAI_API_KEY ??= "test-openai-key";
}

async function loadRuntimeStatusModule() {
  ensureRuntimeStatusEnv();
  return import("../lib/admin/runtime-status");
}

test("buildRpcContractSummary reports missing RPCs against the required set", () => {
  return (async () => {
    const { buildRpcContractSummary } = await loadRuntimeStatusModule();
  const summary = buildRpcContractSummary(
    ["rpc_a", "rpc_b", "rpc_c"],
    [
      { function_name: "rpc_a", is_present: true },
      { function_name: "rpc_b", is_present: false },
    ],
  );

  assert.deepEqual(summary, {
    passed: false,
    requiredRpcCount: 3,
    presentRpcNames: ["rpc_a"],
    missingRpcNames: ["rpc_b", "rpc_c"],
  });
  })();
});

test("summarizeEffectiveDocumentCounts tallies effective document statuses", () => {
  return (async () => {
    const { summarizeEffectiveDocumentCounts } = await loadRuntimeStatusModule();
  const counts = summarizeEffectiveDocumentCounts([
    { effective_status: "queued" },
    { effective_status: "ready" },
    { effective_status: "ready" },
    { effective_status: "failed" },
  ]);

  assert.deepEqual(counts, {
    queued: 1,
    processing: 0,
    ready: 2,
    failed: 1,
  });
  })();
});
