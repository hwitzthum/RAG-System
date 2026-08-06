import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { READER_STATE_PATH } from "./auth-states";
import {
  expectHorizontallyInside,
  expectNoHorizontalOverflow,
} from "./layout-assertions";
import { deleteSeededDocuments, seedReadyDocument } from "./seed-documents";

/**
 * Guards the per-document scope control in the left sidebar.
 *
 * This exists because a purely visual change once pushed the Scope button
 * outside the 280px rail while every other test stayed green: the button was
 * still in the DOM, still "visible" by Playwright's definition (non-empty box,
 * not display:none), and still clickable — Playwright simply scrolled the
 * overflowing rail to reach it. Only its geometry was wrong.
 *
 * So `toBeVisible()` is not enough here. The load-bearing assertion is the
 * geometric one: the control must sit *inside* the sidebar's right edge.
 */

test.describe("Document scope UI", () => {
  test.use({ storageState: READER_STATE_PATH });

  test("reader can scope a search to a document from the left sidebar", async ({
    page,
  }) => {
    // A long name is the point: it is what previously widened the row and
    // pushed the Scope button out of the rail.
    const title = `E2E_Scope_Regression_Long_Document_Name_${randomUUID().slice(0, 8)}.pdf`;
    const documentId = await seedReadyDocument(title);

    try {
      await page.goto("/");
      await page.reload({ waitUntil: "domcontentloaded" });

      const sidebar = page.locator("aside").first();
      const row = sidebar.locator("li").filter({ hasText: title });
      await expect(row).toBeVisible({ timeout: 15_000 });

      const scopeButton = row.getByRole("button", { name: /^Scope$/ });
      await expect(scopeButton).toBeVisible();

      // The regression guards: the control must be reachable, not just present.
      await expectNoHorizontalOverflow(
        sidebar.locator("ul").first(),
        "Document list",
      );
      await expectHorizontallyInside(scopeButton, sidebar, "Scope button");

      // Scope the search to this document.
      await scopeButton.click();

      const scopedButton = row.getByRole("button", { name: /^Scoped$/ });
      await expect(scopedButton).toBeVisible();
      await expectHorizontallyInside(scopedButton, sidebar, "Scoped button");

      // The section header reports what the search now covers.
      await expect(
        sidebar.getByText(/Search scoped to 1 of \d+/),
      ).toBeVisible();

      // ...and the composer reflects the same scope, naming the document.
      const scopePill = page.getByRole("button", {
        name: new RegExp(`Scope.*${title}`, "s"),
      });
      await expect(scopePill).toBeVisible();

      // Toggling off restores the unscoped state end to end.
      await scopedButton.click();
      await expect(row.getByRole("button", { name: /^Scope$/ })).toBeVisible();
      await expect(
        sidebar.getByText(/Search covers all documents/),
      ).toBeVisible();
      await expect(scopePill).toHaveCount(0);
    } finally {
      await deleteSeededDocuments([documentId]);
    }
  });
});
