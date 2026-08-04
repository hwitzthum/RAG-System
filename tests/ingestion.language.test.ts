import assert from "node:assert/strict";
import test from "node:test";
import { assignSectionLanguages } from "../lib/ingestion/runtime/pipeline";
import {
  detectLanguageWithConfidence,
  detectQueryLanguage,
} from "../lib/retrieval/language";

test("detectLanguageWithConfidence reports no confidence when there is no evidence", () => {
  // "COORDINATION & CAPACITY" matched no keyword in any language. With the old
  // accumulator seeded at -1 the first-declared language (DE) won that tie, so
  // English headings were stored as German.
  const detection = detectLanguageWithConfidence("COORDINATION & CAPACITY");

  assert.equal(detection.confident, false);
  assert.equal(detection.score, 0);
});

test("detectLanguageWithConfidence reports no confidence on a cross-language tie", () => {
  // One German keyword and one French keyword: a genuine "don't know" rather
  // than a win for whichever language is declared first.
  const detection = detectLanguageWithConfidence("der le");

  assert.equal(detection.confident, false);
  assert.equal(detection.score, 1);
});

test("detectLanguageWithConfidence is confident with clear evidence", () => {
  assert.deepEqual(
    {
      language: detectLanguageWithConfidence(
        "die Kosten und der Antrag für das Amt",
      ).language,
      confident: detectLanguageWithConfidence(
        "die Kosten und der Antrag für das Amt",
      ).confident,
    },
    { language: "DE", confident: true },
  );

  const english = detectLanguageWithConfidence(
    "the committee and the findings from this review",
  );
  assert.equal(english.language, "EN");
  assert.equal(english.confident, true);
});

test("detectLanguageWithConfidence handles umlauts lost during PDF extraction", () => {
  // " fuer " only existed in the ingestion pipeline's private copy of the
  // keyword table; sharing one table keeps it available to both callers.
  const detection = detectLanguageWithConfidence("Antrag fuer das Amt");

  assert.equal(detection.language, "DE");
  assert.equal(detection.confident, true);
});

test("assignSectionLanguages inherits the document language for evidence-less sections", () => {
  const sections = [
    { text: "COORDINATION & CAPACITY" },
    {
      text: "This report describes the process and the requirements for the applicant.",
    },
    {
      text: "The committee reviewed the findings and the recommendations from this group.",
    },
  ];

  // The bare heading must follow the document, not fall through to whichever
  // language happens to be declared first.
  assert.deepEqual(assignSectionLanguages(sections, null), ["EN", "EN", "EN"]);
});

test("assignSectionLanguages inherits a German majority for the same heading", () => {
  const sections = [
    { text: "COORDINATION & CAPACITY" },
    { text: "Der Antrag und die Kosten für das Amt und der Nachweis." },
    {
      text: "Die Unterlagen und der Bericht für die Prüfung und das Verfahren.",
    },
  ];

  assert.deepEqual(assignSectionLanguages(sections, null), ["DE", "DE", "DE"]);
});

test("assignSectionLanguages keeps a confident section in its own language", () => {
  // Genuinely multilingual documents must still chunk per language.
  const sections = [
    { text: "Der Antrag und die Kosten für das Amt und der Nachweis." },
    {
      text: "The committee reviewed the findings and the recommendations from this group.",
    },
    {
      text: "Die Unterlagen und der Bericht für die Prüfung und das Verfahren.",
    },
  ];

  assert.deepEqual(assignSectionLanguages(sections, null), ["DE", "EN", "DE"]);
});

test("assignSectionLanguages honours an explicit document language hint", () => {
  const sections = [
    {
      text: "The committee reviewed the findings and the recommendations from this group.",
    },
    { text: "COORDINATION & CAPACITY" },
  ];

  assert.deepEqual(assignSectionLanguages(sections, "DE"), ["DE", "DE"]);
});

test("detectQueryLanguage falls back to EN only when there is no evidence at all", () => {
  // A query has no surrounding document to inherit from, so ambiguity and
  // absence are handled differently: absence takes the documented EN default.
  assert.equal(
    detectQueryLanguage("how does artificial intelligence affect employee wellbeing"),
    "EN",
  );
});

test("detectQueryLanguage keeps the leading candidate when evidence is ambiguous", () => {
  // " la " counts for both French and Spanish, so this query ties. Discarding
  // the evidence and answering a French question in English would be worse than
  // taking the leading candidate.
  assert.equal(
    detectQueryLanguage("quelle est la recette traditionnelle de la bouillabaisse"),
    "FR",
  );
});

test("detectQueryLanguage recognises German questions phrased without an article", () => {
  assert.equal(detectQueryLanguage("wie repariere ich einen platten fahrradreifen"), "DE");
  assert.equal(detectQueryLanguage("ist das nicht von der abteilung"), "DE");
});
