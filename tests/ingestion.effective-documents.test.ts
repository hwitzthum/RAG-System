import assert from "node:assert/strict";
import test from "node:test";
import {
  countEffectiveDocumentsByStatus,
  getEffectiveDocumentById,
  listEffectiveDocuments,
} from "../lib/ingestion/runtime/effective-documents";

test("listEffectiveDocuments maps view rows into API payload rows", async () => {
  const supabase = {
    from() {
      return {
        select() {
          return {
            order() {
              return {
                range() {
                  return Promise.resolve({
                    data: [
                      {
                        document_id: "doc-1",
                        title: "Doc 1",
                      effective_status: "ready",
                      created_at: "2026-03-13T00:00:00.000Z",
                      latest_job_status: "completed",
                      latest_job_current_stage: "completed",
                      latest_job_stage_updated_at: "2026-03-13T00:04:00.000Z",
                      latest_job_chunks_processed: 22,
                      latest_job_chunks_total: 22,
                      latest_job_processing_duration_ms: 18503,
                    },
                  ],
                  error: null,
                    count: 1,
                  });
                },
              };
            },
          };
        },
      };
    },
  };

  const result = await listEffectiveDocuments(supabase as never, { limit: 10, offset: 0 });

  assert.deepEqual(result, {
    documents: [
      {
        id: "doc-1",
        title: "Doc 1",
        status: "ready",
        created_at: "2026-03-13T00:00:00.000Z",
        latest_job_status: "completed",
        current_stage: "completed",
        stage_updated_at: "2026-03-13T00:04:00.000Z",
        chunks_processed: 22,
        chunks_total: 22,
        processing_duration_ms: 18503,
      },
    ],
    total: 1,
  });
});

test("getEffectiveDocumentById returns the effective document view row", async () => {
  const supabase = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle() {
                  return Promise.resolve({
                    data: {
                      document_id: "doc-1",
                      title: "Doc 1",
                      effective_status: "processing",
                      ingestion_version: 2,
                      created_at: "2026-03-13T00:00:00.000Z",
                      updated_at: "2026-03-13T00:05:00.000Z",
                      latest_job_id: "job-1",
                      latest_job_status: "processing",
                      latest_job_attempt: 1,
                      latest_job_last_error: null,
                      latest_job_locked_at: "2026-03-13T00:04:00.000Z",
                      latest_job_locked_by: "worker-1",
                      latest_job_current_stage: "embedding",
                      latest_job_stage_updated_at: "2026-03-13T00:04:30.000Z",
                      latest_job_chunks_processed: 5,
                      latest_job_chunks_total: 22,
                      latest_job_processing_duration_ms: 3200,
                      latest_job_created_at: "2026-03-13T00:03:00.000Z",
                      latest_job_updated_at: "2026-03-13T00:04:00.000Z",
                    },
                    error: null,
                  });
                },
              };
            },
          };
        },
      };
    },
  };

  const result = await getEffectiveDocumentById(supabase as never, "doc-1");

  assert.equal(result?.document_id, "doc-1");
  assert.equal(result?.effective_status, "processing");
  assert.equal(result?.latest_job_id, "job-1");
  assert.equal(result?.latest_job_current_stage, "embedding");
  assert.equal(result?.latest_job_chunks_processed, 5);
  assert.equal(result?.latest_job_chunks_total, 22);
});

test("countEffectiveDocumentsByStatus queries the effective-status view with the requested filters", async () => {
  const calls: Array<{ type: string; args: unknown[] }> = [];
  const supabase = {
    from(table: string) {
      calls.push({ type: "from", args: [table] });
      return {
        select(columns: string, options: unknown) {
          calls.push({ type: "select", args: [columns, options] });
          return {
            eq(column: string, value: string) {
              calls.push({ type: "eq", args: [column, value] });
              return {
                gte(columnName: string, cutoff: string) {
                  calls.push({ type: "gte", args: [columnName, cutoff] });
                  return Promise.resolve({
                    count: 3,
                    error: null,
                  });
                },
              };
            },
          };
        },
      };
    },
  };

  const result = await countEffectiveDocumentsByStatus(supabase as never, {
    status: "ready",
    updatedSince: "2026-03-13T00:00:00.000Z",
  });

  assert.equal(result, 3);
  assert.deepEqual(calls, [
    { type: "from", args: ["document_effective_statuses"] },
    { type: "select", args: ["document_id", { head: true, count: "exact" }] },
    { type: "eq", args: ["effective_status", "ready"] },
    { type: "gte", args: ["updated_at", "2026-03-13T00:00:00.000Z"] },
  ]);
});
