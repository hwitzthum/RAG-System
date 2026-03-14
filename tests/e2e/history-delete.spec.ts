import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { READER_STATE_PATH, READER_TOKEN_PATH, getTestAdminClient, loadToken } from "./auth-states";

function decodeJwtSubject(token: string): string {
  const [, payload] = token.split(".");
  if (!payload) {
    throw new Error("Invalid JWT payload");
  }

  const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as { sub?: string };
  if (!json.sub) {
    throw new Error("JWT is missing sub claim");
  }

  return json.sub;
}

async function seedHistoryEntry(input: { userId: string; query: string; conversationId: string; }) {
  const supabase = getTestAdminClient();
  const row = {
    id: randomUUID(),
    user_id: input.userId,
    conversation_id: input.conversationId,
    query: input.query,
    answer: "Seeded answer for delete flow.",
    citations: [],
    latency_ms: 321,
    cache_hit: false,
  };

  const { error } = await supabase.from("query_history").insert(row);
  expect(error).toBeNull();
  return row.id;
}

async function deleteHistoryEntry(historyId: string): Promise<void> {
  const supabase = getTestAdminClient();
  await supabase.from("query_history").delete().eq("id", historyId);
}

test.describe("History deletion UI", () => {
  test.use({ storageState: READER_STATE_PATH });

  test("reader can delete a chat from the left sidebar", async ({ page }) => {
    const userId = decodeJwtSubject(loadToken(READER_TOKEN_PATH));
    const uniqueQuery = `Delete me ${Date.now()} ${randomUUID().slice(0, 8)}`;
    const conversationId = randomUUID();
    const historyId = await seedHistoryEntry({
      userId,
      query: uniqueQuery,
      conversationId,
    });

    try {
      await page.goto("/");
      await page.reload({ waitUntil: "domcontentloaded" });

      const historyItem = page.getByText(uniqueQuery, { exact: true });
      await expect(historyItem).toBeVisible({ timeout: 15_000 });

      const deleteResponsePromise = page.waitForResponse((response) =>
        response.url().includes(`/api/query-history/${historyId}`) &&
        response.request().method() === "DELETE",
      );

      await page.getByLabel(`Delete chat: ${uniqueQuery}`).click();

      const deleteResponse = await deleteResponsePromise;
      expect(deleteResponse.ok()).toBe(true);
      await expect(historyItem).toHaveCount(0);

      const supabase = getTestAdminClient();
      const { data, error } = await supabase
        .from("query_history")
        .select("id")
        .eq("id", historyId)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data).toBeNull();
    } finally {
      await deleteHistoryEntry(historyId);
    }
  });
});
