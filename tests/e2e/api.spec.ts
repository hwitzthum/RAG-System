import { test, expect } from "@playwright/test";

test.describe("API endpoints", () => {
  test("GET /api/health returns ok", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.ok()).toBe(true);
    const json = await response.json();
    expect(json.status).toBe("ok");
    expect(json.service).toBe("rag-system-web");
  });

  test("POST /api/query without auth returns 401", async ({ request }) => {
    const response = await request.post("/api/query", {
      data: { query: "test question", conversationId: "test" },
    });
    expect(response.status()).toBe(401);
  });

  test("POST /api/upload without auth returns 401", async ({ request }) => {
    const response = await request.post("/api/upload", {
      multipart: {
        file: {
          name: "test.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("not a real pdf"),
        },
      },
    });
    expect(response.status()).toBe(401);
  });

  test("POST /api/upload/batch without auth returns 401", async ({ request }) => {
    const response = await request.post("/api/upload/batch", {
      multipart: {
        files: {
          name: "test.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("not a real pdf"),
        },
      },
    });
    expect(response.status()).toBe(401);
  });

  test("POST /api/reports without auth returns 401", async ({ request }) => {
    const response = await request.post("/api/reports", {
      data: { queryHistoryId: "fake-id", format: "docx" },
    });
    expect(response.status()).toBe(401);
  });

  test("POST /api/query with enableWebResearch without auth returns 401", async ({ request }) => {
    const response = await request.post("/api/query", {
      data: { query: "test question", enableWebResearch: true },
    });
    expect(response.status()).toBe(401);
  });
});
