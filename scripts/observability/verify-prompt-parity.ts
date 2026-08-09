#!/usr/bin/env tsx
import assert from "node:assert/strict";
import type {
  RetrievedChunk,
  SupportedLanguage,
} from "../../lib/contracts/retrieval";
import type { WebSource } from "../../lib/web-research/types";
import {
  buildGroundedAnswerVariables,
  GROUNDED_ANSWER_SYSTEM_PROMPT,
  GROUNDED_ANSWER_USER_TEMPLATE,
  INSUFFICIENT_EVIDENCE_TOKEN,
} from "../../lib/answering/prompts";
import {
  buildWebAugmentedVariables,
  WEB_AUGMENTED_SYSTEM_PROMPT,
  WEB_AUGMENTED_USER_TEMPLATE,
} from "../../lib/answering/web-augmented-prompts";
import {
  GROUNDED_ANSWER_PROMPT_NAME,
  resolveAnswerPrompt,
  WEB_AUGMENTED_PROMPT_NAME,
} from "../../lib/answering/prompt-registry";

/**
 * Proves that prompts served by Langfuse Prompt Management render byte-identical
 * text to the in-code templates.
 *
 * Externalising a prompt is only safe if it changes nothing on the way out. The
 * failure this guards against is silent: a stray edit, a lost blank line, or an
 * unsubstituted `{{variable}}` produces a prompt that still looks plausible but
 * no longer matches the one every benchmark number was measured against.
 *
 * Run after `obs:prompts:sync`, and again after editing a prompt in the UI when
 * the edit was meant to be cosmetic.
 */

const CHUNK: RetrievedChunk = {
  chunkId: "chunk-1",
  documentId: "doc-1",
  pageNumber: 7,
  sectionTitle: "Reporting Obligations",
  content: "Quarterly reports are due within 30 days of period end.",
  context: "Section describing the reporting cadence agreed with the donor.",
  language: "EN",
  source: "vector",
  retrievalScore: 0.82,
};

const WEB_SOURCE: WebSource = {
  title: "Donor reporting guidance",
  url: "https://example.org/guidance",
  snippet: "Reports should follow the agreed logframe.",
  relevanceScore: 0.77,
};

const LANGUAGE: SupportedLanguage = "EN";
const QUERY = "What are the reporting obligations?";

function compileLocally(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in variables ? variables[name]! : match,
  );
}

async function main(): Promise<void> {
  const cases: Array<{
    label: string;
    name: string;
    system: string;
    template: string;
    variables: Record<string, string>;
  }> = [
    {
      label: "grounded-answer (no evidence caution)",
      name: GROUNDED_ANSWER_PROMPT_NAME,
      system: GROUNDED_ANSWER_SYSTEM_PROMPT,
      template: GROUNDED_ANSWER_USER_TEMPLATE,
      variables: buildGroundedAnswerVariables({
        query: QUERY,
        language: LANGUAGE,
        chunks: [CHUNK],
      }),
    },
    {
      label: "grounded-answer (CRAG prompt guard active)",
      name: GROUNDED_ANSWER_PROMPT_NAME,
      system: GROUNDED_ANSWER_SYSTEM_PROMPT,
      template: GROUNDED_ANSWER_USER_TEMPLATE,
      variables: buildGroundedAnswerVariables({
        query: QUERY,
        language: LANGUAGE,
        chunks: [CHUNK],
        evidenceCaution: { missingTerms: ["Damnok Toek"] },
      }),
    },
    {
      label: "web-augmented-answer",
      name: WEB_AUGMENTED_PROMPT_NAME,
      system: WEB_AUGMENTED_SYSTEM_PROMPT,
      template: WEB_AUGMENTED_USER_TEMPLATE,
      variables: buildWebAugmentedVariables({
        query: QUERY,
        language: LANGUAGE,
        chunks: [CHUNK],
        webSources: [WEB_SOURCE],
      }),
    },
  ];

  let failures = 0;

  for (const testCase of cases) {
    const remote = await resolveAnswerPrompt({
      name: testCase.name,
      fallback: [
        { role: "system", content: testCase.system },
        { role: "user", content: testCase.template },
      ],
      variables: testCase.variables,
    });

    const expectedSystem = compileLocally(testCase.system, testCase.variables);
    const expectedUser = compileLocally(testCase.template, testCase.variables);

    if (!remote.prompt) {
      console.error(
        `FAIL  ${testCase.label}: served by the in-code fallback, not Langfuse. Run "npm run obs:prompts:sync".`,
      );
      failures += 1;
      continue;
    }

    try {
      assert.equal(remote.systemPrompt, expectedSystem, "system prompt");
      assert.equal(remote.userPrompt, expectedUser, "user prompt");
    } catch {
      console.error(`FAIL  ${testCase.label}: managed prompt text diverged.`);
      failures += 1;
      continue;
    }

    // An unsubstituted placeholder renders as literal "{{name}}" and is the
    // most likely outcome of renaming a variable in the UI.
    const leftover = `${remote.systemPrompt}${remote.userPrompt}`.match(
      /\{\{\w+\}\}/g,
    );
    if (leftover) {
      console.error(
        `FAIL  ${testCase.label}: unsubstituted variables ${[...new Set(leftover)].join(", ")}`,
      );
      failures += 1;
      continue;
    }

    if (!remote.systemPrompt.includes(INSUFFICIENT_EVIDENCE_TOKEN)) {
      console.error(
        `FAIL  ${testCase.label}: abstention token missing from the system prompt; refusals would stop being detected.`,
      );
      failures += 1;
      continue;
    }

    console.log(
      `ok    ${testCase.label} — v${remote.prompt.promptResponse.version}, ${remote.userPrompt.length} chars`,
    );
  }

  if (failures > 0) {
    throw new Error(`${failures} prompt parity check(s) failed`);
  }
  console.log(
    "\nAll managed prompts render identically to the in-code templates.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
