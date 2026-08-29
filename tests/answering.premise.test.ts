import assert from "node:assert/strict";
import test from "node:test";

// The service module validates env at import time; these tests exercise it
// through dynamic imports, so the stubs have to be set before any of them run.
process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY ??= "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-key";
process.env.OPENAI_API_KEY ??= "test-openai-key";
import {
  entityProbeTerms,
  extractClaimedEntities,
  findUnsupportedPremise,
  unsupportedPremiseMessage,
} from "../lib/answering/premise";

test("extractClaimedEntities finds named works and bodies", () => {
  // Every one of these is a real benchmark question that produced a false answer.
  assert.deepEqual(
    extractClaimedEntities(
      "What were the main findings of the 2023 Global AI Integration Report by the FutureTech Alliance?",
    ),
    ["2023 Global AI Integration Report", "FutureTech Alliance"],
  );
  assert.deepEqual(
    extractClaimedEntities(
      "Can you summarize the key findings from the AI Impact Study conducted by the Global Research Institute?",
    ),
    ["AI Impact Study", "Global Research Institute"],
  );
  assert.deepEqual(
    extractClaimedEntities(
      'Was sind die Ergebnisse der Studie "Einfluss von KI auf die Mitarbeiterzufriedenheit"?',
    )[0],
    "Einfluss von KI auf die Mitarbeiterzufriedenheit",
  );
});

test("extractClaimedEntities ignores questions that name nothing specific", () => {
  assert.deepEqual(
    extractClaimedEntities("What does the document say about employee trust?"),
    [],
  );
  // A single capitalised word is not a distinctive name.
  assert.deepEqual(extractClaimedEntities("What is in the Report?"), []);
  assert.deepEqual(
    extractClaimedEntities("Welche Metriken werden im Projekt verwendet?"),
    [],
  );
});

test("entityProbeTerms drops years and connectives", () => {
  assert.deepEqual(entityProbeTerms("2023 Global AI Integration Report"), [
    "Global",
    "Integration",
    "Report",
  ]);
  assert.deepEqual(entityProbeTerms("Future of Work Council"), [
    "Future",
    "Work",
    "Council",
  ]);
});

test("findUnsupportedPremise flags a name the corpus never mentions", async () => {
  const probed: string[][] = [];
  const result = await findUnsupportedPremise({
    question:
      "What recommendations were made in the 2024 report on AI Workforce Development by the Future Skills Council?",
    documentIds: ["doc-1"],
    countMatches: async ({ terms }) => {
      probed.push(terms);
      return 0;
    },
  });

  assert.deepEqual(result, { entity: "Future Skills Council" });
  assert.deepEqual(probed[0], ["Future", "Skills", "Council"]);
});

test("findUnsupportedPremise clears a name the corpus does mention", async () => {
  // "Caritas Forward" is a real project in the corpus (12 chunks mention it),
  // so the ordinary evidence gate must be left to decide.
  const result = await findUnsupportedPremise({
    question:
      "Wie hängt das Projekt 'Caritas Forward' mit der Schweizer KI-Plattform zusammen?",
    documentIds: ["doc-1"],
    countMatches: async () => 12,
  });

  assert.equal(result, null);
});

test("findUnsupportedPremise never probes when the question names nothing", async () => {
  let calls = 0;
  const result = await findUnsupportedPremise({
    question: "What does the document say about trust?",
    documentIds: ["doc-1"],
    countMatches: async () => {
      calls += 1;
      return 0;
    },
  });

  assert.equal(result, null);
  assert.equal(calls, 0);
});

test("findUnsupportedPremise does not probe an empty library", async () => {
  // An unscoped probe would be an existence oracle over other accounts' documents.
  let calls = 0;
  const result = await findUnsupportedPremise({
    question: "What did the FutureTech Alliance report say?",
    documentIds: [],
    countMatches: async () => {
      calls += 1;
      return 0;
    },
  });

  assert.equal(result, null);
  assert.equal(calls, 0);
});

test("unsupportedPremiseMessage names the missing entity", () => {
  const message = unsupportedPremiseMessage("FutureTech Alliance");
  assert.equal(message.includes("FutureTech Alliance"), true);
  // Must not read as a retrieval failure, which would invite a pointless retry.
  assert.equal(message.includes("not have enough evidence"), false);
});

import type { RetrievedChunk } from "../lib/contracts/retrieval";

function strongChunk(index: number): RetrievedChunk {
  return {
    chunkId: `chunk-${index}`,
    documentId: "doc-1",
    documentTitle: "Employee Wellbeing AI",
    chunkIndex: index,
    pageNumber: index + 1,
    sectionTitle: "Employee Perceptions of AI",
    content:
      "Employees reported higher trust in AI systems when managers explained how decisions were reached.",
    context: "Findings on trust in workplace AI.",
    language: "EN",
    retrievalScore: 0.9,
    rerankScore: 0.9,
    relevanceScore: 0.9,
    scoreScale: "cross_encoder",
    source: "vector",
  } as RetrievedChunk;
}

test("the grounded path refuses before generating when a premise is unsupported", async () => {
  // The evidence here is strong and genuinely about workplace AI — which is
  // exactly why relevance gating cannot catch this. The question attributes it
  // to a report that does not exist.
  const { generateGroundedAnswer } = await import("../lib/answering/service");
  let llmCalled = false;

  const result = await generateGroundedAnswer(
    {
      query:
        "What were the main findings of the 2023 Global AI Integration Report by the FutureTech Alliance?",
      language: "EN",
      chunks: [strongChunk(0), strongChunk(1)],
      minEvidenceChunks: 1,
      minRerankScore: 0.1,
      minHeuristicRelevance: 0.14,
      maxOutputTokens: 500,
      unsupportedPremiseEntity: "FutureTech Alliance",
    },
    {
      llmProvider: {
        async generateAnswer() {
          llmCalled = true;
          return { text: "Fabricated findings.", truncated: false };
        },
      },
      verifyCitations: async () => null as never,
    },
  );

  assert.equal(llmCalled, false);
  assert.equal(result.insufficientEvidence, true);
  assert.equal(result.answer.includes("FutureTech Alliance"), true);
  assert.equal(result.answer.includes("not have enough evidence"), false);
});

test("web research is not a way around the premise gate", async () => {
  const { generateWebAugmentedAnswer } = await import(
    "../lib/answering/service"
  );
  let llmCalled = false;

  const result = await generateWebAugmentedAnswer(
    {
      query:
        "What were the main findings of the 2023 Global AI Integration Report by the FutureTech Alliance?",
      language: "EN",
      chunks: [strongChunk(0), strongChunk(1)],
      minEvidenceChunks: 1,
      minRerankScore: 0.1,
      minHeuristicRelevance: 0.14,
      maxOutputTokens: 500,
      unsupportedPremiseEntity: "FutureTech Alliance",
      webSources: [
        {
          title: "AI integration trends",
          url: "https://example.com/a",
          snippet: "Broad coverage of AI integration in workplaces.",
        },
      ] as never,
      minWebSources: 1,
    },
    {
      llmProvider: {
        async generateAnswer() {
          llmCalled = true;
          return { text: "Fabricated findings.", truncated: false };
        },
      },
      verifyCitations: async () => null as never,
    },
  );

  assert.equal(llmCalled, false);
  assert.equal(result.answer.includes("FutureTech Alliance"), true);
});
