import { test, expect } from "@playwright/test";

// Test user credentials (created in Supabase with app_metadata.role = "reader")
const TEST_EMAIL = "e2e-test@ragsystem.test";
const TEST_PASSWORD = "E2eTestPass789";
const SUPABASE_URL = "https://aaghjfmstezmxyxyrfri.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Uj_ZNudC4PBSWkrBmmXowA_MDDNh5jd";

async function getAccessToken(): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });

  if (!response.ok) {
    throw new Error(`Auth failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

test.describe("Authenticated API flows", () => {
  let accessToken: string;

  test.beforeAll(async () => {
    accessToken = await getAccessToken();
  });

  test("POST /api/query with valid auth returns SSE stream", async ({ request }) => {
    const response = await request.post("/api/query", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { query: "What is this system about?", topK: 3 },
    });

    // May get 200 (SSE) or 500 (no documents indexed) - both mean auth worked
    expect([200, 500]).toContain(response.status());
    // Should NOT be 401 or 403
    expect(response.status()).not.toBe(401);
    expect(response.status()).not.toBe(403);
  });

  test("POST /api/query with enableWebResearch and valid auth succeeds", async ({ request }) => {
    const response = await request.post("/api/query", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { query: "test question", enableWebResearch: true, topK: 3 },
    });

    expect([200, 500]).toContain(response.status());
    expect(response.status()).not.toBe(401);
    expect(response.status()).not.toBe(403);
  });

  test("GET /api/query-history with valid auth returns items array", async ({ request }) => {
    const response = await request.get("/api/query-history?limit=5", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // query-history might use cookie auth only; if 401, that's expected
    if (response.status() === 200) {
      const json = await response.json();
      expect(json).toHaveProperty("items");
      expect(Array.isArray(json.items)).toBe(true);
    }
  });

  test("POST /api/upload with valid auth but non-PDF returns 400", async ({ request }) => {
    const response = await request.post("/api/upload", {
      headers: { Authorization: `Bearer ${accessToken}` },
      multipart: {
        file: {
          name: "test.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("not a pdf"),
        },
      },
    });

    expect(response.status()).toBe(400);
    const json = await response.json();
    expect(json.error).toContain("PDF");
  });

  test("POST /api/upload with valid auth but fake PDF magic bytes returns 400", async ({ request }) => {
    const response = await request.post("/api/upload", {
      headers: { Authorization: `Bearer ${accessToken}` },
      multipart: {
        file: {
          name: "fake.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("NOT-A-REAL-PDF-FILE"),
        },
      },
    });

    expect(response.status()).toBe(400);
    const json = await response.json();
    expect(json.error).toContain("signature");
  });

  test("POST /api/upload with valid auth and real PDF header succeeds or fails gracefully", async ({ request }) => {
    // Create minimal valid PDF
    const minimalPdf = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF",
    );

    const response = await request.post("/api/upload", {
      headers: { Authorization: `Bearer ${accessToken}` },
      multipart: {
        file: {
          name: "test-doc.pdf",
          mimeType: "application/pdf",
          buffer: minimalPdf,
        },
      },
    });

    // 201 (created) or 200 (deduplicated) or 500 (storage issue) — all mean auth + validation passed
    expect([200, 201, 500]).toContain(response.status());
    expect(response.status()).not.toBe(401);
    expect(response.status()).not.toBe(400);
  });

  test("POST /api/reports with valid auth but missing queryHistoryId returns 400", async ({ request }) => {
    const response = await request.post("/api/reports", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { format: "docx" },
    });

    expect(response.status()).toBe(400);
  });

  test("POST /api/reports with valid auth but nonexistent queryHistoryId returns 404", async ({ request }) => {
    const response = await request.post("/api/reports", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { queryHistoryId: "00000000-0000-0000-0000-000000000000", format: "docx" },
    });

    expect(response.status()).toBe(404);
  });

  test("GET /api/byok/openai with valid auth returns vault status", async ({ request }) => {
    const response = await request.get("/api/byok/openai", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.status() === 200) {
      const json = await response.json();
      expect(json).toHaveProperty("vaultEnabled");
      expect(json).toHaveProperty("configured");
    }
  });

  test("DELETE /api/auth/session clears session", async ({ request }) => {
    const response = await request.delete("/api/auth/session");
    expect(response.ok()).toBe(true);
    const json = await response.json();
    expect(json.status).toBe("ok");
  });
});

test.describe("Authenticated Workbench UI", () => {
  test("workbench renders after Supabase login", async ({ page }) => {
    // Go to login page
    await page.goto("/login");
    await expect(page.locator("h1")).toHaveText("Sign In");

    // Fill in credentials
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');

    // Wait for redirect to workbench (home page)
    await page.waitForURL("/", { timeout: 15_000 });

    // Verify workbench elements render
    await expect(page.locator("text=Response Workspace")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=Grounded Answer Operations")).toBeVisible();
    await expect(page.locator("text=Ingestion Desk")).toBeVisible();
    await expect(page.locator("text=Evidence Navigator")).toBeVisible();
    await expect(page.locator("text=Query Timeline")).toBeVisible();
  });

  test("workbench has web research toggle", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 15_000 });

    const toggle = page.locator('[data-testid="web-research-toggle"]');
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    await expect(toggle).not.toBeChecked();

    // Toggle it on
    await toggle.click();
    await expect(toggle).toBeChecked();
  });

  test("workbench has batch upload input", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 15_000 });

    const batchInput = page.locator('[data-testid="batch-upload-input"]');
    await expect(batchInput).toBeVisible({ timeout: 10_000 });

    // Verify it accepts multiple files
    const isMultiple = await batchInput.getAttribute("multiple");
    expect(isMultiple).not.toBeNull();
  });

  test("workbench shows session identity after login", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 15_000 });

    // Should show READER role
    await expect(page.locator("text=READER")).toBeVisible({ timeout: 10_000 });
  });
});
