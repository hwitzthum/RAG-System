import assert from "node:assert/strict";
import test from "node:test";
import { isDocumentOverviewQuery } from "../lib/retrieval/intent";

test("isDocumentOverviewQuery detects summary and overview phrasing for a single scoped document", () => {
  assert.equal(isDocumentOverviewQuery("please summarize the document for me", ["doc-1"]), true);
  assert.equal(isDocumentOverviewQuery("what is this document about?", ["doc-1"]), true);
  assert.equal(isDocumentOverviewQuery("was ist der inhalt dieses dokuments", ["doc-1"]), true);
  assert.equal(isDocumentOverviewQuery("peux-tu résumer le document ?", ["doc-1"]), true);
  assert.equal(isDocumentOverviewQuery("puoi fare una sintesi del documento?", ["doc-1"]), true);
  assert.equal(isDocumentOverviewQuery("puedes resumir el documento?", ["doc-1"]), true);
});

test("isDocumentOverviewQuery stays off for specific scoped questions and multi-document scope", () => {
  assert.equal(isDocumentOverviewQuery("what does the document say about governance?", ["doc-1"]), false);
  assert.equal(isDocumentOverviewQuery("please summarize the document for me", ["doc-1", "doc-2"]), false);
});
