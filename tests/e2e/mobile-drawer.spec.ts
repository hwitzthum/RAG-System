import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { ADMIN_STATE_PATH, getTestAdminClient } from "./auth-states";
import { deleteSeededDocuments, seedReadyDocument } from "./seed-documents";

/** Below the `lg` breakpoint the rail is display:none and the drawer serves in its place. */
const MOBILE_VIEWPORT = { width: 420, height: 900 };

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

/**
 * Loads the workbench and waits for the client-side document fetch. The panel
 * toggle is a client handler, so clicking before hydration silently does
 * nothing — this fetch only fires after mount, making it a reliable gate.
 */
async function gotoHydratedWorkbench(page: Page): Promise<void> {
  await page.goto("/");
  const documentsLoaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/documents" &&
      response.request().method() === "GET",
    { timeout: 15_000 },
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await documentsLoaded;
}

test.describe("Mobile left drawer", () => {
  test.use({ storageState: ADMIN_STATE_PATH, viewport: MOBILE_VIEWPORT });

  // The drawer once rendered only a "use desktop view for full sidebar" note,
  // which put document deletion entirely out of reach on a narrow window.
  test("admin can delete a document from the mobile drawer", async ({
    page,
  }) => {
    const title = `ZZ_E2E_MOBILE_${randomUUID().slice(0, 8)}.pdf`;
    const documentId = await seedReadyDocument(title);

    try {
      await gotoHydratedWorkbench(page);

      // The rail exists in the DOM at this width but must not be visible.
      await expect(page.getByTestId("sidebar-left-rail")).toBeHidden();
      await expect(page.getByTestId("sidebar-left-drawer")).toHaveCount(0);

      await page.getByRole("button", { name: "Toggle left panel" }).click();
      const drawer = page.getByTestId("sidebar-left-drawer");
      await expect(drawer).toBeVisible();

      const deleteButton = drawer.getByLabel(`Delete document: ${title}`);
      await expect(deleteButton).toBeVisible({ timeout: 15_000 });

      await deleteButton.click();
      await page.getByTestId("confirm-delete-confirm").click();

      await expect(deleteButton).toHaveCount(0);
      expect(await documentExists(documentId)).toBe(false);

      // Deleting keeps the drawer open so several can be removed in one pass.
      await expect(drawer).toBeVisible();
    } finally {
      await deleteSeededDocuments([documentId]);
    }
  });

  test("starting a new chat closes the drawer", async ({ page }) => {
    await gotoHydratedWorkbench(page);

    await page.getByRole("button", { name: "Toggle left panel" }).click();
    const drawer = page.getByTestId("sidebar-left-drawer");
    await expect(drawer).toBeVisible();

    await drawer.getByRole("button", { name: "New Chat" }).click();
    await expect(drawer).toHaveCount(0);
  });
});

test.describe("Mobile right drawer", () => {
  test.use({ storageState: ADMIN_STATE_PATH, viewport: MOBILE_VIEWPORT });

  // The toggle used to render the backdrop and no panel at all, so upload,
  // evidence and the key vault were unreachable on a narrow window.
  test("toggle opens a panel rather than only a backdrop", async ({ page }) => {
    await gotoHydratedWorkbench(page);

    await expect(page.getByTestId("sidebar-right-rail")).toBeHidden();
    await expect(page.getByTestId("sidebar-right-drawer")).toHaveCount(0);

    await page.getByRole("button", { name: "Toggle right panel" }).click();
    const drawer = page.getByTestId("sidebar-right-drawer");
    await expect(drawer).toBeVisible();

    // The tabs are the panel's content; a bare backdrop would have none.
    for (const label of ["Evidence", "Upload", "Status"]) {
      await expect(drawer.getByRole("button", { name: label })).toBeVisible();
    }

    // The upload controls are the reason the panel matters on mobile.
    await drawer.getByRole("button", { name: "Upload" }).click();
    await expect(drawer.getByText("Ingestion Desk")).toBeVisible();

    // Tapping the exposed strip of backdrop dismisses it. The drawer covers the
    // backdrop's centre, so aim at the uncovered left edge — the strip the
    // drawer's max-width guarantees is always there.
    await page
      .getByTestId("mobile-panel-backdrop")
      .click({ position: { x: 20, y: 400 } });
    await expect(drawer).toHaveCount(0);
  });
});
