import assert from "node:assert/strict";
import test from "node:test";
import {
  countEffectiveDocumentsByStatus,
  getEffectiveDocumentById,
  listAccessibleDocumentIds,
  listEffectiveDocuments,
} from "../lib/ingestion/runtime/effective-documents";

test("listEffectiveDocuments maps view rows into API payload rows", async () => {
  const calls: Array<{ type: string; args: unknown[] }> = [];
  const supabase = {
    from(table: string) {
      calls.push({ type: "from", args: [table] });
      if (table === "documents") {
        return {
          select(columns: string) {
            calls.push({ type: "select:documents", args: [columns] });
            return {
              eq(column: string, value: string) {
                calls.push({ type: "eq:documents", args: [column, value] });
                return {
                  or(filter: string) {
                    calls.push({ type: "or:documents", args: [filter] });
                    return {
                      returns() {
                        return Promise.resolve({
                          data: [{ id: "doc-1" }],
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
      }
      return {
        select(columns: string, options: unknown) {
          calls.push({ type: "select", args: [columns, options] });
          return {
            order(column: string, optionsArg: unknown) {
              calls.push({ type: "order", args: [column, optionsArg] });
              return {
                in(columnName: string, values: string[]) {
                  calls.push({ type: "in", args: [columnName, values] });
                  return {
                    range(start: number, end: number) {
                      calls.push({ type: "range", args: [start, end] });
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
    },
  };

  const result = await listEffectiveDocuments(supabase as never, {
    limit: 10,
    offset: 0,
    user: { id: "reader-1", role: "reader", email: "reader@example.com" },
  });

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
  assert.deepEqual(calls, [
    { type: "from", args: ["documents"] },
    { type: "select:documents", args: ["id"] },
    { type: "eq:documents", args: ["status", "ready"] },
    { type: "or:documents", args: ["user_id.eq.reader-1,user_id.is.null"] },
    { type: "from", args: ["document_effective_statuses"] },
    {
      type: "select",
      args: [
        "document_id,title,effective_status,created_at,latest_job_status,latest_job_current_stage,latest_job_stage_updated_at,latest_job_chunks_processed,latest_job_chunks_total,latest_job_processing_duration_ms",
        { count: "planned" },
      ],
    },
    { type: "order", args: ["created_at", { ascending: false }] },
    { type: "in", args: ["document_id", ["doc-1"]] },
    { type: "range", args: [0, 9] },
  ]);
});

test("listEffectiveDocuments skips ownership filtering for admins", async () => {
  const calls: Array<{ type: string; args: unknown[] }> = [];
  const supabase = {
    from() {
      return {
        select() {
          return {
            order() {
              return {
                range(start: number, end: number) {
                  calls.push({ type: "range", args: [start, end] });
                  return Promise.resolve({
                    data: [],
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

  await listEffectiveDocuments(supabase as never, {
    limit: 10,
    offset: 0,
    user: { id: "admin-1", role: "admin", email: "admin@example.com" },
  });

  assert.deepEqual(calls, [{ type: "range", args: [0, 9] }]);
});

test("getEffectiveDocumentById returns the effective document view row", async () => {
  const calls: Array<{ type: string; args: unknown[] }> = [];
  const supabase = {
    from(table: string) {
      calls.push({ type: "from", args: [table] });
      if (table === "documents") {
        return {
          select(columns: string) {
            calls.push({ type: "select:documents", args: [columns] });
            return {
              eq(column: string, value: string) {
                calls.push({ type: "eq:documents", args: [column, value] });
                return {
                  or(filter: string) {
                    calls.push({ type: "or:documents", args: [filter] });
                    return {
                      maybeSingle() {
                        return Promise.resolve({
                          data: { id: "doc-1" },
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
      }

      return {
        select() {
          return {
            eq(column: string, value: string) {
              calls.push({ type: "eq", args: [column, value] });
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

  const result = await getEffectiveDocumentById(supabase as never, {
    user: { id: "reader-1", role: "reader", email: "reader@example.com" },
    documentId: "doc-1",
  });

  assert.equal(result?.document_id, "doc-1");
  assert.equal(result?.effective_status, "processing");
  assert.equal(result?.latest_job_id, "job-1");
  assert.equal(result?.latest_job_current_stage, "embedding");
  assert.equal(result?.latest_job_chunks_processed, 5);
  assert.equal(result?.latest_job_chunks_total, 22);
  assert.deepEqual(calls, [
    { type: "from", args: ["documents"] },
    { type: "select:documents", args: ["id"] },
    { type: "eq:documents", args: ["id", "doc-1"] },
    { type: "or:documents", args: ["user_id.eq.reader-1,user_id.is.null"] },
    { type: "from", args: ["document_effective_statuses"] },
    { type: "eq", args: ["document_id", "doc-1"] },
  ]);
});

test("listAccessibleDocumentIds returns shared and owned ready documents for readers", async () => {
  const calls: Array<{ type: string; args: unknown[] }> = [];
  const supabase = {
    from(table: string) {
      calls.push({ type: "from", args: [table] });
      return {
        select(columns: string) {
          calls.push({ type: "select", args: [columns] });
          return {
            eq(column: string, value: string) {
              calls.push({ type: "eq", args: [column, value] });
              return {
                or(value: string) {
                  calls.push({ type: "or", args: [value] });
                  return {
                    returns() {
                      return Promise.resolve({
                        data: [{ id: "doc-1" }, { id: "doc-2" }, { id: "doc-1" }],
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
    },
  };

  const result = await listAccessibleDocumentIds(supabase as never, {
    user: { id: "reader-1", role: "reader", email: "reader@example.com" },
  });

  assert.deepEqual(result, ["doc-1", "doc-2"]);
  assert.deepEqual(calls, [
    { type: "from", args: ["documents"] },
    { type: "select", args: ["id"] },
    { type: "eq", args: ["status", "ready"] },
    { type: "or", args: ["user_id.eq.reader-1,user_id.is.null"] },
  ]);
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
