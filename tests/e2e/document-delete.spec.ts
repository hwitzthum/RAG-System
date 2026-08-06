import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { ADMIN_STATE_PATH, getTestAdminClient } from "./auth-states";
import { deleteSeededDocuments, seedReadyDocument } from "./seed-documents";

async function documentExists(documentId: string): Promise<boolean> {
  const supabase = getTestAdminClient();
  const { data, error } = await supabase
    .from("documents")
    .select("id")
    .eq("id", documentId)
    .maybeSingle();

  expect(error).toBeNull();
  return data !== null;
}

test.describe("Document deletion UI", () => {
  test.use({ storageState: ADMIN_STATE_PATH });

  // The delete control is irreversible and sits one click from the query rail,
  // so the gate matters as much as the delete itself. Both halves are asserted
  // against the database, not just the list.
  test("admin must confirm before a document is deleted", async ({ page }) => {
    const title = `ZZ_E2E_DELETE_${randomUUID().slice(0, 8)}.pdf`;
    const documentId = await seedReadyDocument(title);

    try {
      await page.goto("/");
      await page.reload({ waitUntil: "domcontentloaded" });

      const deleteButton = page.getByLabel(`Delete document: ${title}`);
      await expect(deleteButton).toBeVisible({ timeout: 15_000 });

      // Cancel must leave the document untouched.
      await deleteButton.click();
      const dialog = page.getByTestId("confirm-delete-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(title);
      await page.getByTestId("confirm-delete-cancel").click();
      await expect(dialog).toBeHidden();
      expect(await documentExists(documentId)).toBe(true);

      // Confirm deletes it.
      const deleteResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes(`/api/documents/${documentId}`) &&
          response.request().method() === "DELETE",
      );
      await deleteButton.click();
      await page.getByTestId("confirm-delete-confirm").click();

      const deleteResponse = await deleteResponsePromise;
      expect(deleteResponse.ok()).toBe(true);
      await expect(deleteButton).toHaveCount(0);
      expect(await documentExists(documentId)).toBe(false);
    } finally {
      await deleteSeededDocuments([documentId]);
    }
  });
});
