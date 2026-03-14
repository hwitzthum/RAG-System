import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeleteQueryHistoryClient,
  deleteQueryHistoryEntry,
  type DeleteQueryHistoryClient,
  type DeleteQueryHistorySupabaseClient,
} from "../lib/query-history/delete-query-history";

test("createDeleteQueryHistoryClient scopes deletion to the entry and owner", async () => {
  const filters: Array<{ column: string; value: string }> = [];
  const supabase: DeleteQueryHistorySupabaseClient = {
    from(table) {
      assert.equal(table, "query_history");
      return {
        delete() {
          return {
            eq(column, value) {
              filters.push({ column, value });
              return {
                eq(nextColumn, nextValue) {
                  filters.push({ column: nextColumn, value: nextValue });
                  return {
                    async select(columns) {
                      assert.equal(columns, "id,conversation_id");
                      return { data: [], error: null };
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

  const client = createDeleteQueryHistoryClient(supabase);
  await client.deleteQueryHistory({ entryId: "history-1", userId: "user-1" });

  assert.deepEqual(filters, [
    { column: "id", value: "history-1" },
    { column: "user_id", value: "user-1" },
  ]);
});

test("deleteQueryHistoryEntry returns the deleted row metadata", async () => {
  const client: DeleteQueryHistoryClient = {
    async deleteQueryHistory() {
      return {
        data: [
          {
            id: "history-1",
            conversation_id: "conversation-1",
          },
        ],
        error: null,
      };
    },
  };

  const result = await deleteQueryHistoryEntry({
    client,
    entryId: "history-1",
    userId: "user-1",
  });

  assert.deepEqual(result, {
    id: "history-1",
    conversationId: "conversation-1",
  });
});

test("deleteQueryHistoryEntry returns null when no row was deleted", async () => {
  const client: DeleteQueryHistoryClient = {
    async deleteQueryHistory() {
      return { data: [], error: null };
    },
  };

  const result = await deleteQueryHistoryEntry({
    client,
    entryId: "missing-history",
    userId: "user-1",
  });

  assert.equal(result, null);
});

test("deleteQueryHistoryEntry throws when the delete fails", async () => {
  const client: DeleteQueryHistoryClient = {
    async deleteQueryHistory() {
      return {
        data: null,
        error: { message: "database offline" },
      };
    },
  };

  await assert.rejects(
    deleteQueryHistoryEntry({
      client,
      entryId: "history-1",
      userId: "user-1",
    }),
    /Failed to delete query history entry: database offline/,
  );
});
