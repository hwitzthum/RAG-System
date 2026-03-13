import assert from "node:assert/strict";
import test from "node:test";
import { deleteDocumentCascade, type DeleteDocumentClient } from "../lib/documents/delete-document";

function createRpcSuccessClient(): DeleteDocumentClient {
  return {
    async runDeleteDocumentCascadeRpc() {
      return {
        data: [
          {
            document_id: "doc-1",
            storage_path: "uploads/doc-1.pdf",
            deleted_job_count: 2,
            deleted_chunk_count: 11,
          },
        ],
        error: null,
      };
    },
  };
}

test("deleteDocumentCascade returns mapped RPC rows", async () => {
  const result = await deleteDocumentCascade({
    client: createRpcSuccessClient(),
    documentId: "doc-1",
  });

  assert.deepEqual(result, {
    documentId: "doc-1",
    storagePath: "uploads/doc-1.pdf",
    deletedJobCount: 2,
    deletedChunkCount: 11,
  });
});

test("deleteDocumentCascade returns null when RPC reports no row", async () => {
  const client: DeleteDocumentClient = {
    async runDeleteDocumentCascadeRpc() {
      return { data: [], error: null };
    },
  };

  const result = await deleteDocumentCascade({
    client,
    documentId: "missing-doc",
  });

  assert.equal(result, null);
});

test("deleteDocumentCascade throws when the RPC is unavailable", async () => {
  const client: DeleteDocumentClient = {
    async runDeleteDocumentCascadeRpc() {
      return {
        data: null,
        error: { message: "Could not find the function public.delete_document_cascade" },
      };
    },
  };

  await assert.rejects(
    deleteDocumentCascade({
      client,
      documentId: "doc-1",
    }),
    /Required ingestion RPC delete_document_cascade is unavailable/,
  );
});
