import assert from "node:assert/strict";
import test from "node:test";
import {
  purgeUserDocuments,
  type PurgeUserDocumentsClient,
} from "../lib/documents/purge-user-documents";

type Row = { id: string; storage_path: string | null };

function createClient(options: {
  rows: Row[];
  listError?: string;
  rpcErrorFor?: string;
  rowsAfterPurge?: Row[];
}): PurgeUserDocumentsClient & { deletedIds: string[]; listCalls: string[] } {
  const deletedIds: string[] = [];
  const listCalls: string[] = [];
  let listCount = 0;
  return {
    deletedIds,
    listCalls,
    async listOwnedDocuments(userId) {
      listCalls.push(userId);
      listCount += 1;
      if (options.listError) {
        return { data: null, error: { message: options.listError } };
      }
      if (listCount === 1) return { data: options.rows, error: null };
      return { data: options.rowsAfterPurge ?? [], error: null };
    },
    async runDeleteDocumentCascadeRpc(args) {
      if (args.target_document_id === options.rpcErrorFor) {
        return { data: null, error: { message: "boom" } };
      }
      deletedIds.push(args.target_document_id);
      const row = options.rows.find((r) => r.id === args.target_document_id);
      return {
        data: [
          {
            document_id: args.target_document_id,
            storage_path: row?.storage_path ?? "",
            deleted_job_count: 1,
            deleted_chunk_count: 3,
          },
        ],
        error: null,
      };
    },
  };
}

const USER_ID = "11111111-1111-4111-8111-111111111111";

test("purgeUserDocuments deletes every owned document and returns storage paths", async () => {
  const client = createClient({
    rows: [
      { id: "doc-1", storage_path: "a/doc-1.pdf" },
      { id: "doc-2", storage_path: "b/doc-2.pdf" },
    ],
  });

  const result = await purgeUserDocuments({ client, userId: USER_ID });

  assert.deepEqual(client.deletedIds, ["doc-1", "doc-2"]);
  assert.deepEqual(result.deletedDocumentIds, ["doc-1", "doc-2"]);
  assert.deepEqual(result.storagePaths, ["a/doc-1.pdf", "b/doc-2.pdf"]);
  assert.deepEqual(client.listCalls, [USER_ID, USER_ID]);
});

test("purgeUserDocuments is a no-op for users without documents", async () => {
  const client = createClient({ rows: [] });
  const result = await purgeUserDocuments({ client, userId: USER_ID });
  assert.deepEqual(result, { deletedDocumentIds: [], storagePaths: [] });
  assert.deepEqual(client.deletedIds, []);
});

test("purgeUserDocuments throws when listing documents fails", async () => {
  const client = createClient({ rows: [], listError: "db down" });
  await assert.rejects(
    purgeUserDocuments({ client, userId: USER_ID }),
    /Failed to list user documents: db down/,
  );
});

test("purgeUserDocuments throws (so user deletion aborts) when a cascade delete fails", async () => {
  const client = createClient({
    rows: [
      { id: "doc-1", storage_path: "a/doc-1.pdf" },
      { id: "doc-2", storage_path: "b/doc-2.pdf" },
    ],
    rpcErrorFor: "doc-2",
  });
  await assert.rejects(
    purgeUserDocuments({ client, userId: USER_ID }),
    /Failed to delete document via RPC: boom/,
  );
});

test("purgeUserDocuments throws when documents remain after the purge", async () => {
  const client = createClient({
    rows: [{ id: "doc-1", storage_path: "a/doc-1.pdf" }],
    rowsAfterPurge: [{ id: "doc-late", storage_path: "c/doc-late.pdf" }],
  });
  await assert.rejects(
    purgeUserDocuments({ client, userId: USER_ID }),
    /still owns documents/,
  );
});
