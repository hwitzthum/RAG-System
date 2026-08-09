#!/usr/bin/env tsx
import { LangfuseClient } from "@langfuse/client";
import {
  GROUNDED_ANSWER_SYSTEM_PROMPT,
  GROUNDED_ANSWER_USER_TEMPLATE,
} from "../../lib/answering/prompts";
import {
  WEB_AUGMENTED_SYSTEM_PROMPT,
  WEB_AUGMENTED_USER_TEMPLATE,
} from "../../lib/answering/web-augmented-prompts";
import {
  GROUNDED_ANSWER_PROMPT_NAME,
  WEB_AUGMENTED_PROMPT_NAME,
} from "../../lib/answering/prompt-registry";

/**
 * Seeds the answering prompts into Langfuse Prompt Management.
 *
 * Intended for first-time setup and disaster recovery, NOT as a deploy step.
 * Once a prompt exists, Langfuse is the source of truth — this script leaves it
 * alone unless `--force` is passed, because re-uploading on every deploy would
 * silently revert edits made in the UI, which is the whole point of managing
 * prompts there.
 *
 * The in-code templates it uploads stay in the codebase as the runtime
 * fallback (see lib/answering/prompt-registry.ts), so they are never dead
 * copies.
 */

type PromptSpec = {
  name: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
};

const PROMPTS: PromptSpec[] = [
  {
    name: GROUNDED_ANSWER_PROMPT_NAME,
    messages: [
      { role: "system", content: GROUNDED_ANSWER_SYSTEM_PROMPT },
      { role: "user", content: GROUNDED_ANSWER_USER_TEMPLATE },
    ],
  },
  {
    name: WEB_AUGMENTED_PROMPT_NAME,
    messages: [
      { role: "system", content: WEB_AUGMENTED_SYSTEM_PROMPT },
      { role: "user", content: WEB_AUGMENTED_USER_TEMPLATE },
    ],
  },
];

async function productionVersionExists(
  langfuse: LangfuseClient,
  name: string,
): Promise<boolean> {
  try {
    await langfuse.prompt.get(name, {
      type: "chat",
      label: "production",
      cacheTtlSeconds: 0,
    });
    return true;
  } catch {
    // Any failure to read is treated as "not present". The caller only uses
    // this to decide whether to skip, and creating a duplicate version is
    // recoverable whereas skipping a genuinely missing prompt is not.
    return false;
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");

  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    throw new Error(
      "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set to sync prompts.",
    );
  }

  const langfuse = new LangfuseClient();

  for (const spec of PROMPTS) {
    const exists = await productionVersionExists(langfuse, spec.name);

    if (exists && !force) {
      console.log(
        `skipped  ${spec.name} — a production version already exists (pass --force to publish a new version from code)`,
      );
      continue;
    }

    await langfuse.prompt.create({
      name: spec.name,
      type: "chat",
      prompt: spec.messages,
      labels: ["production"],
    });

    console.log(
      `${exists ? "updated" : "created"}  ${spec.name} (label: production)`,
    );
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Prompt sync failed: ${message}`);
  process.exitCode = 1;
});
