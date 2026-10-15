import assert from "node:assert/strict";
import test from "node:test";
import { openAiChatParams } from "@/lib/providers/openai-chat";

test("gpt-6-luna gets reasoning effort none, so temperature 0 is accepted", () => {
  assert.deepEqual(
    openAiChatParams({ model: "gpt-6-luna", maxCompletionTokens: 300 }),
    { reasoning_effort: "none", temperature: 0, max_completion_tokens: 300 },
  );
});

test("gpt-6-sol gets effort none; gpt-6.1-sol, which rejects it, does not", () => {
  assert.equal(
    openAiChatParams({ model: "gpt-6-sol", maxCompletionTokens: 300 })
      .reasoning_effort,
    "none",
  );
  assert.equal(
    "reasoning_effort" in
      openAiChatParams({ model: "gpt-6.1-sol", maxCompletionTokens: 300 }),
    false,
  );
});

test("models without reasoning effort never receive the parameter", () => {
  // gpt-4o-mini answers `reasoning_effort` with "Unrecognized request argument".
  const params = openAiChatParams({
    model: "gpt-4o-mini",
    maxCompletionTokens: 140,
    temperature: 0.2,
  });

  assert.equal("reasoning_effort" in params, false);
  assert.deepEqual(params, { temperature: 0.2, max_completion_tokens: 140 });
});

test("max_tokens is never sent — reasoning models reject it", () => {
  for (const model of ["gpt-6-luna", "gpt-6-sol", "gpt-4o-mini"]) {
    const params = openAiChatParams({ model, maxCompletionTokens: 64 });
    assert.equal("max_tokens" in params, false);
  }
});

test("Fast mode is requested only for gpt-6-luna, and only when enabled", () => {
  assert.equal(
    openAiChatParams({ model: "gpt-6-luna", maxCompletionTokens: 64, fastMode: true })
      .service_tier,
    "fast",
  );
  for (const model of ["gpt-6-sol", "gpt-4o-mini"]) {
    const params = openAiChatParams({ model, maxCompletionTokens: 64, fastMode: true });
    assert.equal("service_tier" in params, false, model);
  }
  assert.equal(
    "service_tier" in
      openAiChatParams({ model: "gpt-6-luna", maxCompletionTokens: 64, fastMode: false }),
    false,
  );
});
