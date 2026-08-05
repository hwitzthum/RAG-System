import assert from "node:assert/strict";
import test from "node:test";
import type {
  RetrievedChunk,
  SupportedLanguage,
} from "../lib/contracts/retrieval";
import type { CitationVerification } from "../lib/answering/verification";

process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY ??= "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-key";
process.env.OPENAI_API_KEY ??= "test-openai-key";

function buildChunk(overrides: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    chunkId: "chunk-1",
    documentId: "doc-1",
    pageNumber: 1,
    sectionTitle: "Overview",
    content: "The programme funds rural broadband deployment across regions.",
    context: "Broadband policy overview.",
    language: "EN",
    source: "hybrid",
    retrievalScore: 0.2,
    ...overrides,
  };
}

// Gate inputs are function arguments; only the loop flags and the top-3-mean
// bars come from env. relevance 0.28/0.27 passes the hard gate (0.25) but
// misses the 0.30 sufficiency bar -> ambiguous.
function ambiguousChunks(): RetrievedChunk[] {
  return [
    buildChunk({
      chunkId: "chunk-1",
      relevanceScore: 0.28,
      scoreScale: "cross_encoder",
    }),
    buildChunk({
      chunkId: "chunk-2",
      relevanceScore: 0.27,
      scoreScale: "cross_encoder",
      content: "Regional funding is disbursed annually by the ministry.",
    }),
  ];
}

function sufficientChunks(): RetrievedChunk[] {
  return [
    buildChunk({
      chunkId: "chunk-1",
      relevanceScore: 0.6,
      scoreScale: "cross_encoder",
    }),
    buildChunk({
      chunkId: "chunk-2",
      relevanceScore: 0.5,
      scoreScale: "cross_encoder",
      content: "Regional funding is disbursed annually by the ministry.",
    }),
  ];
}

const UNVERIFIED_STUB: CitationVerification = {
  checkedCount: 0,
  supportedCount: 0,
  unsupportedCount: 0,
  unverified: true,
};

type AskOptions = {
  chunks: RetrievedChunk[];
  answerText?: string;
  verification?: CitationVerification;
  correctiveRetrieve?: (
    query: string,
    language: SupportedLanguage,
  ) => Promise<RetrievedChunk[]>;
  query?: string;
};

async function ask(options: AskOptions) {
  const { generateGroundedAnswer } = await import("../lib/answering/service");
  let capturedPrompt = "";

  const result = await generateGroundedAnswer(
    {
      query:
        options.query ??
        'What does the "Quantum Shield Initiative" say about budget?',
      language: "EN",
      chunks: options.chunks,
      minEvidenceChunks: 2,
      minRerankScore: 0.25,
      minHeuristicRelevance: 0.14,
      maxOutputTokens: 500,
    },
    {
      llmProvider: {
        async generateAnswer(input) {
          capturedPrompt = input.userPrompt;
          return {
            text:
              options.answerText ??
              "The budget is disbursed annually [1]. Regions apply directly [2].",
            truncated: false,
          };
        },
      },
      verifyCitations: async () => options.verification ?? UNVERIFIED_STUB,
      correctiveRetrieve: options.correctiveRetrieve,
    },
  );

  return { result, capturedPrompt };
}

/**
 * The env module is loaded once per process, so per-test configuration
 * mutates the parsed config object and restores it afterwards.
 */
async function withEnv(
  overrides: Record<string, unknown>,
  fn: () => Promise<void>,
): Promise<void> {
  const { env } = await import("../lib/config/env");
  const mutable = env as unknown as Record<string, unknown>;
  const previous: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = mutable[key];
    mutable[key] = value;
  }
  try {
    await fn();
  } finally {
    Object.assign(mutable, previous);
  }
}

test("(a) ambiguous band with the guard on: prompt carries the caution and missing terms", async () => {
  await withEnv({ RAG_CRAG_LOOP_ENABLED: true }, async () => {
    const { result, capturedPrompt } = await ask({ chunks: ambiguousChunks() });

    assert.ok(
      capturedPrompt.includes("Retrieval confidence for this query is low."),
    );
    assert.ok(
      capturedPrompt.includes(
        "The following terms from the question were not found in the evidence: Quantum Shield Initiative.",
      ),
    );
    assert.equal(result.evidenceAssessment?.verdict, "ambiguous");
    assert.equal(result.evidenceAssessment?.loopEnabled, true);
    assert.deepEqual(result.evidenceAssessment?.actionsTaken, ["prompt_guard"]);
    assert.equal(result.insufficientEvidence, false);
  });
});

test("(b) sufficient band: prompt is byte-identical with the loop on and off", async () => {
  let promptLoopOn = "";
  await withEnv({ RAG_CRAG_LOOP_ENABLED: true }, async () => {
    const { result, capturedPrompt } = await ask({
      chunks: sufficientChunks(),
    });
    promptLoopOn = capturedPrompt;
    assert.equal(result.evidenceAssessment?.verdict, "sufficient");
    assert.deepEqual(result.evidenceAssessment?.actionsTaken, []);
  });

  const { capturedPrompt: promptLoopOff } = await ask({
    chunks: sufficientChunks(),
  });
  assert.equal(promptLoopOn, promptLoopOff);
  assert.equal(promptLoopOn.includes("Retrieval confidence"), false);
});

test("(c) reflection retracts when the unsupported share reaches the bar", async () => {
  await withEnv(
    { RAG_CRAG_LOOP_ENABLED: true, RAG_CRAG_PROMPT_GUARD_ENABLED: false },
    async () => {
      const verification: CitationVerification = {
        checkedCount: 4,
        supportedCount: 2,
        unsupportedCount: 2,
        unverified: false,
      };
      const { result } = await ask({
        chunks: ambiguousChunks(),
        verification,
      });

      assert.equal(result.insufficientEvidence, true);
      assert.deepEqual(result.outputFilter.reasons, [
        "reflection_unsupported_citations",
      ]);
      // The verification that triggered the retraction stays auditable.
      assert.deepEqual(result.citationVerification, verification);
      assert.deepEqual(result.evidenceAssessment?.actionsTaken, [
        "reflection_unsupported_citations",
      ]);
    },
  );
});

test("(d) an unverified verifier result never retracts", async () => {
  await withEnv({ RAG_CRAG_LOOP_ENABLED: true }, async () => {
    const { result } = await ask({
      chunks: ambiguousChunks(),
      verification: {
        checkedCount: 5,
        supportedCount: 0,
        unsupportedCount: 5,
        unverified: true,
      },
    });

    assert.equal(result.insufficientEvidence, false);
  });
});

test("(e) below the minimum checked count, reflection never retracts", async () => {
  await withEnv({ RAG_CRAG_LOOP_ENABLED: true }, async () => {
    // Share 1.0 but only one checked sentence (min is 2).
    const { result } = await ask({
      chunks: ambiguousChunks(),
      verification: {
        checkedCount: 1,
        supportedCount: 0,
        unsupportedCount: 1,
        unverified: false,
      },
    });

    assert.equal(result.insufficientEvidence, false);
  });
});

test("(f) a token-prefixed answer abstains in the ambiguous band only", async () => {
  const prefixedAnswer =
    "INSUFFICIENT_EVIDENCE — the initiative is not mentioned in the evidence.";

  await withEnv({ RAG_CRAG_LOOP_ENABLED: true }, async () => {
    const ambiguous = await ask({
      chunks: ambiguousChunks(),
      answerText: prefixedAnswer,
    });
    assert.equal(ambiguous.result.insufficientEvidence, true);
    assert.deepEqual(ambiguous.result.outputFilter.reasons, [
      "model_abstention_prefix",
    ]);
    assert.ok(
      ambiguous.result.evidenceAssessment?.actionsTaken.includes(
        "model_abstention_prefix",
      ),
    );

    // Sufficient band: the same output is treated as a real answer.
    const sufficient = await ask({
      chunks: sufficientChunks(),
      answerText: prefixedAnswer,
    });
    assert.equal(sufficient.result.insufficientEvidence, false);
  });

  // Loop off: the prefix detector is inert even for ambiguous evidence.
  const loopOff = await ask({
    chunks: ambiguousChunks(),
    answerText: prefixedAnswer,
  });
  assert.equal(loopOff.result.insufficientEvidence, false);
});

test("(g) loop off: ambiguous behaves like sufficient, assessment still recorded", async () => {
  const loopOff = await ask({ chunks: ambiguousChunks() });
  assert.equal(loopOff.result.insufficientEvidence, false);
  assert.equal(
    loopOff.result.answer,
    "The budget is disbursed annually [1]. Regions apply directly [2].",
  );
  assert.equal(loopOff.result.evidenceAssessment?.verdict, "ambiguous");
  assert.equal(loopOff.result.evidenceAssessment?.loopEnabled, false);
  assert.deepEqual(loopOff.result.evidenceAssessment?.actionsTaken, []);
  assert.equal(loopOff.capturedPrompt.includes("Retrieval confidence"), false);

  // Behaviorally identical to the loop-on sufficient treatment of the same
  // pool: same prompt, same answer.
  let promptLoopOn = "";
  await withEnv(
    { RAG_CRAG_LOOP_ENABLED: true, RAG_CRAG_PROMPT_GUARD_ENABLED: false },
    async () => {
      const { capturedPrompt } = await ask({ chunks: ambiguousChunks() });
      promptLoopOn = capturedPrompt;
    },
  );
  assert.equal(loopOff.capturedPrompt, promptLoopOn);
});

test("(i) corrective retrieval runs only when enabled, and merges deduped", async () => {
  const correctiveChunks: RetrievedChunk[] = [
    // Duplicate of chunk-1 with a better score: dedupe must keep the best.
    buildChunk({
      chunkId: "chunk-1",
      relevanceScore: 0.9,
      scoreScale: "cross_encoder",
    }),
    buildChunk({
      chunkId: "chunk-3",
      relevanceScore: 0.8,
      scoreScale: "cross_encoder",
      content: "Corrective evidence on the Quantum Shield Initiative budget.",
    }),
  ];
  let calls = 0;
  const correctiveRetrieve = async () => {
    calls += 1;
    return correctiveChunks;
  };

  // Flag off (default): never invoked, even in the ambiguous band.
  await withEnv({ RAG_CRAG_LOOP_ENABLED: true }, async () => {
    await ask({ chunks: ambiguousChunks(), correctiveRetrieve });
    assert.equal(calls, 0);
  });

  await withEnv(
    {
      RAG_CRAG_LOOP_ENABLED: true,
      RAG_CRAG_CORRECTIVE_RETRIEVAL_ENABLED: true,
    },
    async () => {
      const { result, capturedPrompt } = await ask({
        chunks: ambiguousChunks(),
        correctiveRetrieve,
      });

      assert.equal(calls, 1);
      // The merged pool reaches the prompt: new evidence present, the
      // duplicated chunk exactly once.
      assert.ok(capturedPrompt.includes("Corrective evidence on the Quantum"));
      assert.equal(
        capturedPrompt.split(
          "The programme funds rural broadband deployment across regions.",
        ).length - 1,
        1,
      );
      assert.ok(
        result.evidenceAssessment?.actionsTaken.includes(
          "corrective_retrieval",
        ),
      );
      // Post-merge re-assessment reads the strengthened pool.
      assert.equal(result.evidenceAssessment?.verdict, "sufficient");
    },
  );
});
