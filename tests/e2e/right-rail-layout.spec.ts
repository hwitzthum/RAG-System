import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { READER_STATE_PATH } from "./auth-states";
import {
  expectHorizontallyInside,
  expectNoHorizontalOverflow,
  expectNoWrappedButtons,
} from "./layout-assertions";
import {
  deleteSeededDocuments,
  longDocumentTitle,
  seedReadyDocument,
} from "./seed-documents";

/**
 * Layout guard for the 320px right rail.
 *
 * The rail packs the densest controls in the app — a file picker, a title
 * field, a language select, a scrollable scope list, batch upload, an upload
 * status panel and three provider key vaults — into a fixed narrow column.
 * Everything here is driven by user-supplied strings (document titles, file
 * names), so it is the most likely place for content to widen a container and
 * push trailing controls out of view.
 *
 * The rail is exercised with long document titles because short ones do not
 * reproduce the failure.
 */

/**
 * Switches tabs and confirms the switch actually happened.
 *
 * A plain click is not enough: a click landing before React hydrates is
 * silently dropped, so the tab silently stays put and the failure surfaces
 * later as a confusing "element not found" on the panel's heading. Retry the
 * click until its effect is observable.
 */
async function openTab(
  page: Page,
  tab: "Evidence" | "Upload" | "Status",
  heading: string,
) {
  const button = page
    .locator("aside button")
    .filter({ hasText: new RegExp(`^${tab}$`) });

  await expect(async () => {
    await button.click();
    // By role, not text: "Status" is both a tab label and a panel heading.
    await expect(
      rightRail(page).getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

function rightRail(page: Page) {
  return page.locator("aside").last();
}

test.describe("Right rail layout", () => {
  test.use({ storageState: READER_STATE_PATH });

  let documentIds: string[] = [];

  test.beforeAll(async () => {
    documentIds = await Promise.all([
      seedReadyDocument(longDocumentTitle(`a_${randomUUID().slice(0, 6)}`)),
      seedReadyDocument(longDocumentTitle(`b_${randomUUID().slice(0, 6)}`)),
      seedReadyDocument(longDocumentTitle(`c_${randomUUID().slice(0, 6)}`)),
    ]);
  });

  test.afterAll(async () => {
    await deleteSeededDocuments(documentIds);
  });

  test("no tab overflows the rail with long document titles", async ({
    page,
  }) => {
    await page.goto("/");
    await page.reload({ waitUntil: "domcontentloaded" });

    const rail = rightRail(page);
    await expect(rail).toBeVisible({ timeout: 15_000 });

    // Evidence — empty state. Populated citation cards are covered by the
    // grounded-query test, which is the only place real citations exist.
    await openTab(page, "Evidence", "Evidence Navigator");
    await expectNoHorizontalOverflow(rail, "Right rail · Evidence tab");

    // Upload — the dense one. Wait for the seeded titles to reach the scope list.
    await openTab(page, "Upload", "Ingestion Desk");
    await expect(
      rail.getByText(/Projektbeschreibungen_Gesamtprojekt/).first(),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expectNoHorizontalOverflow(rail, "Right rail · Upload tab");

    // ...and again with every provider key vault expanded, which is where the
    // tracked-caps button labels previously broke out of their tile.
    const summaries = rail.locator("details summary");
    const vaultCount = await summaries.count();
    expect(
      vaultCount,
      "expected provider key vaults in the Upload tab",
    ).toBeGreaterThan(0);
    for (let i = 0; i < vaultCount; i += 1) {
      await summaries.nth(i).click();
    }
    // Name-agnostic wait, so a layout failure below reports as a layout
    // failure rather than as a missing-button timeout.
    await expect(rail.locator("details button").first()).toBeVisible();
    await expectNoHorizontalOverflow(
      rail,
      "Right rail · Upload tab, vaults expanded",
    );
    await expectNoWrappedButtons(
      rail,
      "Right rail · Upload tab, vaults expanded",
    );

    // Every vault action must sit inside the rail, not merely exist.
    for (const action of ["Save", "Clear", "Refresh", "Remove"] as const) {
      await expectHorizontallyInside(
        rail.getByRole("button", { name: new RegExp(`^${action}$`) }).first(),
        rail,
        `Vault "${action}" button`,
      );
    }

    await openTab(page, "Status", "Status");
    await expect(page.getByTestId("workspace-status-message")).toBeVisible();
    await expectNoHorizontalOverflow(rail, "Right rail · Status tab");
  });
});
