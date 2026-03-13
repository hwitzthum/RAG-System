import { test as setup, expect, type Page } from "@playwright/test";
import {
  READER_STATE_PATH,
  ADMIN_STATE_PATH,
  READER_TOKEN_PATH,
  ADMIN_TOKEN_PATH,
  saveToken,
  getTestAdminClient,
  fetchAccessToken,
} from "./auth-states";

const READER_EMAIL = process.env.E2E_TEST_EMAIL!;
const READER_PASSWORD = process.env.E2E_TEST_PASSWORD!;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL!;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD!;

async function clearRateLimitBuckets(): Promise<void> {
  const supabase = getTestAdminClient();
  await supabase.from("rate_limit_buckets").delete().neq("bucket_key", "");
}

async function getAndSaveToken(email: string, password: string, tokenPath: string): Promise<void> {
  const token = await fetchAccessToken(email, password);
  saveToken(tokenPath, token);
}

async function loginAndSaveState(
  page: Page,
  email: string,
  password: string,
  storagePath: string,
) {
  await page.goto("/login");
  await expect(page.locator("h1")).toHaveText("Sign In", { timeout: 10_000 });

  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');

  await page.waitForURL("/", { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Response Workspace" })).toBeVisible({ timeout: 15_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.context().storageState({ path: storagePath });
}

setup("clear rate limit buckets", async () => {
  await clearRateLimitBuckets();
});

setup("authenticate as reader", async ({ page }) => {
  await getAndSaveToken(READER_EMAIL, READER_PASSWORD, READER_TOKEN_PATH);
  await loginAndSaveState(page, READER_EMAIL, READER_PASSWORD, READER_STATE_PATH);
});

setup("authenticate as admin", async ({ page }) => {
  await getAndSaveToken(ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_TOKEN_PATH);
  await loginAndSaveState(page, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_STATE_PATH);
});
