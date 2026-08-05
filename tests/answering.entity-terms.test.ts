import assert from "node:assert/strict";
import test from "node:test";
import {
  checkEntityGrounding,
  extractQueryEntityTerms,
} from "../lib/answering/entity-terms";
import type { RetrievedChunk } from "../lib/contracts/retrieval";

function buildChunk(overrides: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    chunkId: "chunk-1",
    documentId: "doc-1",
    pageNumber: 1,
    sectionTitle: "Overview",
    content: "baseline content",
    context: "baseline context",
    language: "EN",
    source: "hybrid",
    retrievalScore: 0.2,
    ...overrides,
  };
}

// --- Extraction --------------------------------------------------------------

test("extracts quoted phrases and capitalized runs from an EN query", () => {
  const terms = extractQueryEntityTerms(
    'What does the "Green Deal Report" say about Horizon Europe funding?',
    "EN",
  );

  assert.ok(terms.includes("Green Deal Report"));
  assert.ok(terms.includes("Horizon Europe"));
});

test("a single mid-sentence capitalized word counts in EN", () => {
  const terms = extractQueryEntityTerms("What did Brussels decide?", "EN");
  assert.deepEqual(terms, ["Brussels"]);
});

test("sentence-initial capitalized runs are excluded", () => {
  // Every sentence starts capitalized, so position proves nothing.
  assert.deepEqual(
    extractQueryEntityTerms("Horizon told nobody anything.", "EN"),
    [],
  );
  assert.deepEqual(
    extractQueryEntityTerms("Horizon Europe was discussed there.", "EN"),
    [],
  );
});

test("DE: single capitalized words are nouns, not entities; runs of two are", () => {
  // Every German noun is capitalized — "Programm" and "Jahr" must not count.
  const terms = extractQueryEntityTerms(
    "Was kostet das Programm Erasmus Plus im Jahr 2027?",
    "DE",
  );

  assert.ok(terms.includes("Programm Erasmus Plus"));
  assert.equal(terms.includes("Jahr"), false);

  assert.deepEqual(
    extractQueryEntityTerms("Wie hoch ist die Förderung im Programm?", "DE"),
    [],
  );
});

test("capitalized stopwords are filtered and break runs", () => {
  const terms = extractQueryEntityTerms(
    "Does the European Union And Council agree? What does This mean?",
    "EN",
  );

  assert.ok(terms.includes("European Union"));
  assert.ok(terms.includes("Council"));
  assert.equal(terms.includes("And"), false);
  assert.equal(terms.includes("This"), false);
  assert.equal(
    terms.some((term) => term.includes("And")),
    false,
  );
});

// --- Grounding ---------------------------------------------------------------

test("a fabricated entity is reported missing", () => {
  const check = checkEntityGrounding({
    query: 'What does the "Quantum Shield Initiative" cover?',
    language: "EN",
    chunks: [
      buildChunk({
        content: "The programme funds rural broadband deployment.",
        context: "Broadband policy overview.",
      }),
    ],
  });

  assert.deepEqual(check.terms, ["Quantum Shield Initiative"]);
  assert.deepEqual(check.missingTerms, ["Quantum Shield Initiative"]);
});

test("DE: a term contained in a larger compound is grounded", () => {
  const check = checkEntityGrounding({
    query: 'Welche "Wirkungsindikatoren" gelten für das Programm?',
    language: "DE",
    chunks: [
      buildChunk({
        content:
          "Der Wirkungsindikatorenrahmen beschreibt die Messgrößen des Programms.",
        context: "Kapitel zu Evaluation.",
      }),
    ],
  });

  assert.deepEqual(check.missingTerms, []);
});

test("DE: an inflected evidence form is not falsely missing", () => {
  // "Europäische Kommission" vs. evidence "der Europäischen Kommission":
  // the full-phrase substring fails on the -n inflection, the per-token
  // 5-char-prefix match does not.
  const check = checkEntityGrounding({
    query: "Was plant die Europäische Kommission für 2027?",
    language: "DE",
    chunks: [
      buildChunk({
        content:
          "Der Vorschlag der Europäischen Kommission umfasst drei Säulen.",
        context: "",
      }),
    ],
  });

  assert.deepEqual(check.terms, ["Europäische Kommission"]);
  assert.deepEqual(check.missingTerms, []);
});

test("grounded terms appearing verbatim in content or context are not missing", () => {
  const check = checkEntityGrounding({
    query: 'How is "Horizon Europe" governed?',
    language: "EN",
    chunks: [
      buildChunk({
        content: "Unrelated paragraph.",
        context: "This chunk is part of the Horizon Europe governance annex.",
      }),
    ],
  });

  assert.deepEqual(check.missingTerms, []);
});
