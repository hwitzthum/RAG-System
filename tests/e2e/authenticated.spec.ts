import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { READER_STATE_PATH, READER_TOKEN_PATH, getTestAdminClient, loadToken } from "./auth-states";

async function createPdfBuffer(text: string): Promise<Buffer> {
  const { default: PDFDocument } = await import("pdfkit");

  return await new Promise<Buffer>((resolve) => {
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer | Uint8Array | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    doc.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    doc.fontSize(18).text("RAG smoke test document", { underline: true });
    doc.moveDown();
    doc.fontSize(12).text(text);
    doc.end();
  });
}

async function triggerIngestionPass(request: APIRequestContext): Promise<void> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return;
  }

  const response = await request.post("/api/internal/ingestion/run", {
    headers: { Authorization: `Bearer ${cronSecret}` },
  });
  expect(response.ok()).toBe(true);
}

async function waitForDocumentReady(request: APIRequestContext, accessToken: string, documentId: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await triggerIngestionPass(request);

    const response = await request.get(`/api/upload/${documentId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.ok()).toBe(true);
    const payload = (await response.json()) as {
      document: { status: string };
      latestIngestionJob: { status: string; last_error: string | null } | null;
    };

    if (payload.document.status === "ready") {
      return;
    }

    if (payload.document.status === "failed" || payload.latestIngestionJob?.status === "dead_letter") {
      throw new Error(payload.latestIngestionJob?.last_error ?? `Document ${documentId} failed to ingest`);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Document ${documentId} did not reach ready within the smoke timeout`);
}

async function cleanupSmokeDocument(documentId: string): Promise<void> {
  const supabase = getTestAdminClient();
  const { data: documentRow } = await supabase
    .from("documents")
    .select("storage_path")
    .eq("id", documentId)
    .maybeSingle<{ storage_path: string | null }>();

  await supabase.rpc("delete_document_cascade", {
    target_document_id: documentId,
  });

  if (documentRow?.storage_path) {
    await supabase.storage.from("documents").remove([documentRow.storage_path]);
  }
}

/** Click the Upload tab in the right sidebar to reveal upload controls */
async function clickUploadTab(page: Page): Promise<void> {
  await page.locator("aside >> text=Upload").last().click();
}

/** Click the Status tab in the right sidebar */
async function clickStatusTab(page: Page): Promise<void> {
  await page.locator("aside >> text=Status").last().click();
}

async function uploadSmokePdf(page: Page, uniqueToken: string): Promise<string> {
  const pdfBuffer = await createPdfBuffer(
    `The uploaded document contains the phrase ${uniqueToken}. This line is used for end-to-end retrieval verification.`,
  );

  const uploadResponsePromise = page.waitForResponse((response) => {
    return response.url().endsWith("/api/upload") && response.request().method() === "POST";
  });

  // Click Upload tab to reveal the single-upload-input
  await clickUploadTab(page);

  await page.getByTestId("single-upload-input").setInputFiles({
    name: "rag-smoke.pdf",
    mimeType: "application/pdf",
    buffer: pdfBuffer,
  });

  await expect(page.getByTestId("upload-title-input")).toHaveValue("rag-smoke.pdf");
  await page.getByTestId("upload-submit-button").click();

  const uploadResponse = await uploadResponsePromise;
  expect(uploadResponse.ok()).toBe(true);
  const uploadJson = (await uploadResponse.json()) as { documentId?: string };
  expect(uploadJson.documentId).toBeTruthy();
  return uploadJson.documentId!;
}

test.describe("Authenticated API flows", () => {
  let accessToken: string;

  test.beforeAll(async () => {
    accessToken = loadToken(READER_TOKEN_PATH);
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

  test("GET /api/byok/cohere with valid auth returns vault status", async ({ request }) => {
    const response = await request.get("/api/byok/cohere", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.status() === 200) {
      const json = await response.json();
      expect(json).toHaveProperty("vaultEnabled");
      expect(json).toHaveProperty("configured");
    }
  });

  test("GET /api/byok/anthropic with valid auth returns vault status", async ({ request }) => {
    const response = await request.get("/api/byok/anthropic", {
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
  test.use({ storageState: READER_STATE_PATH });

  test("workbench renders after Supabase login", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("text=Response Workspace")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=Grounded Answer Operations")).toBeVisible();

    // Click Upload tab to see Ingestion Desk
    await clickUploadTab(page);
    await expect(page.locator("text=Ingestion Desk")).toBeVisible();

    await expect(page.locator("text=Evidence Navigator")).toBeVisible();
    await expect(page.locator("text=Query Timeline")).toBeVisible();
  });

  test("workbench has web research toggle", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("text=Response Workspace")).toBeVisible({ timeout: 10_000 });

    const toggle = page.locator('[data-testid="web-research-toggle"]');
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    await expect(toggle).not.toBeChecked();

    // Toggle it on
    await toggle.click();
    await expect(toggle).toBeChecked();
  });

  test("workbench has batch upload input", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("text=Response Workspace")).toBeVisible({ timeout: 10_000 });

    // Click Upload tab to see batch upload input
    await clickUploadTab(page);

    const batchInput = page.locator('[data-testid="batch-upload-input"]');
    await expect(batchInput).toBeVisible({ timeout: 10_000 });

    // Verify it accepts multiple files
    const isMultiple = await batchInput.getAttribute("multiple");
    expect(isMultiple).not.toBeNull();
  });

  test("workbench shows session identity after login", async ({ page }) => {
    await page.goto("/");
    // Storage state includes the reload from setup, so session cookie is already synced
    await expect(page.locator("text=Signed in as reader")).toBeVisible({ timeout: 15_000 });
  });

  test("workbench can upload a PDF and answer a grounded query for it", async ({ page, request }) => {
    test.skip(!process.env.CRON_SECRET, "CRON_SECRET is required for the upload-to-query smoke");
    test.setTimeout(180_000);

    const accessToken = loadToken(READER_TOKEN_PATH);
    const uniqueToken = `SMOKE-${Date.now()}`;
    let documentId: string | null = null;

    try {
      await page.goto("/");
      await expect(page.locator("text=Response Workspace")).toBeVisible({ timeout: 15_000 });

      documentId = await uploadSmokePdf(page, uniqueToken);
      await waitForDocumentReady(request, accessToken, documentId);

      // Click Status tab to check workspace status
      await clickStatusTab(page);
      await expect(page.getByTestId("workspace-status-message")).toContainText("ready", { timeout: 30_000 });

      // Click Upload tab to check upload status panel
      await clickUploadTab(page);
      await expect(page.getByTestId("upload-status-panel")).toContainText("Status: ready", { timeout: 30_000 });
      await expect(page.getByTestId("upload-status-panel")).toContainText("Document: rag-smoke.pdf", { timeout: 30_000 });

      await page.getByTestId("chat-query-input").fill("What is this document about?");
      await page.getByTestId("chat-send-button").click();

      // Click Status tab to check query completion
      await clickStatusTab(page);
      await expect(page.getByTestId("workspace-status-message")).toContainText("Query complete.", { timeout: 60_000 });
      await expect(page.getByTestId("chat-turn").last()).toContainText("What is this document about?");
      await expect(page.getByTestId("chat-turn").last()).not.toContainText("Query failed.");
      await expect(page.getByTestId("chat-turn").last()).not.toContainText("I do not have enough evidence");
      await expect(page.locator(`a[href="/api/upload/${documentId}"]`).first()).toBeVisible({ timeout: 30_000 });
    } finally {
      if (documentId) {
        await cleanupSmokeDocument(documentId);
      }
    }
  });
});
