import { test, expect } from "@playwright/test";

// Credentials loaded from .env.local via playwright.config.ts
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL!;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD!;

const PENDING_EMAIL = process.env.E2E_PENDING_EMAIL!;
const PENDING_PASSWORD = process.env.E2E_PENDING_PASSWORD!;
const PENDING_USER_ID = process.env.E2E_PENDING_USER_ID!;

const READER_EMAIL = process.env.E2E_TEST_EMAIL!;
const READER_PASSWORD = process.env.E2E_TEST_PASSWORD!;

async function getAccessToken(email: string, password: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`Auth failed: ${response.status}`);
  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

async function resetPendingUserRole(): Promise<void> {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${PENDING_USER_ID}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({ app_metadata: { role: "pending" } }),
  });
}

test.describe("Admin API", () => {
  let adminToken: string;

  test.beforeAll(async () => {
    adminToken = await getAccessToken(ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  test("GET /api/admin/users with admin auth returns user list", async ({ request }) => {
    const response = await request.get("/api/admin/users", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(response.ok()).toBe(true);
    const json = (await response.json()) as { users: Array<{ id: string; email: string; role: string }> };
    expect(json.users).toBeDefined();
    expect(json.users.length).toBeGreaterThan(0);

    // Should contain known test users
    const emails = json.users.map((u) => u.email);
    expect(emails).toContain(ADMIN_EMAIL);
    expect(emails).toContain(READER_EMAIL);
  });

  test("GET /api/admin/users with reader auth returns 403", async ({ request }) => {
    const readerToken = await getAccessToken(READER_EMAIL, READER_PASSWORD);
    const response = await request.get("/api/admin/users", {
      headers: { Authorization: `Bearer ${readerToken}` },
    });
    expect(response.status()).toBe(403);
  });

  test("GET /api/admin/users without auth returns 401", async ({ request }) => {
    const response = await request.get("/api/admin/users");
    expect(response.status()).toBe(401);
  });

  test("PATCH /api/admin/users/:id can approve a pending user", async ({ request }) => {
    // Reset pending user first
    await resetPendingUserRole();

    const response = await request.patch(`/api/admin/users/${PENDING_USER_ID}`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      data: { role: "reader" },
    });

    expect(response.ok()).toBe(true);
    const json = (await response.json()) as { role: string };
    expect(json.role).toBe("reader");

    // Reset back to pending for other tests
    await resetPendingUserRole();
  });

  test("PATCH /api/admin/users/:id prevents self-demotion", async ({ request }) => {
    // Get admin user's ID from the list
    const listResponse = await request.get("/api/admin/users", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const listJson = (await listResponse.json()) as { users: Array<{ id: string; email: string }> };
    const adminUser = listJson.users.find((u) => u.email === ADMIN_EMAIL);
    expect(adminUser).toBeDefined();

    const response = await request.patch(`/api/admin/users/${adminUser!.id}`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      data: { role: "reader" },
    });

    expect(response.status()).toBe(400);
    const json = (await response.json()) as { error: string };
    expect(json.error).toContain("own role");
  });

  test("PATCH /api/admin/users/:id can suspend a user", async ({ request }) => {
    // Reset pending user to reader first
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${PENDING_USER_ID}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({ app_metadata: { role: "reader" } }),
    });

    const response = await request.patch(`/api/admin/users/${PENDING_USER_ID}`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      data: { role: "suspended" },
    });

    expect(response.ok()).toBe(true);
    const json = (await response.json()) as { role: string };
    expect(json.role).toBe("suspended");

    // Reset back to pending
    await resetPendingUserRole();
  });
});

test.describe("Pending approval flow", () => {
  test.beforeEach(async () => {
    await resetPendingUserRole();
  });

  test("pending user gets 403 on query API", async ({ request }) => {
    const pendingToken = await getAccessToken(PENDING_EMAIL, PENDING_PASSWORD);
    const response = await request.post("/api/query", {
      headers: {
        Authorization: `Bearer ${pendingToken}`,
        "Content-Type": "application/json",
      },
      data: { query: "test question", topK: 3 },
    });

    // Query route allows ["reader", "admin"] — pending should be 403
    expect(response.status()).toBe(403);
  });

  test("pending user gets 403 on upload API", async ({ request }) => {
    const pendingToken = await getAccessToken(PENDING_EMAIL, PENDING_PASSWORD);
    const response = await request.post("/api/upload", {
      headers: { Authorization: `Bearer ${pendingToken}` },
      multipart: {
        file: {
          name: "test.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("%PDF-1.4 test"),
        },
      },
    });

    expect(response.status()).toBe(403);
  });
});

test.describe("Auth rate limiting", () => {
  test("login rate limit returns 429 after too many attempts", async ({ request }) => {
    // Make 22 login attempts with wrong password (rate limit: 20 per 5 min per IP+email)
    const responses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const response = await request.post("/api/auth/login", {
        data: { email: "ratelimit-test@example.com", password: "wrongpassword" },
      });
      responses.push(response.status());
    }

    // At least one should be 429
    expect(responses).toContain(429);
  });
});

test.describe("Admin page UI", () => {
  test("admin can access /admin page and see user table", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 15_000 });

    // Navigate to admin page
    await page.goto("/admin");
    await expect(page.locator("h1")).toHaveText("User Management", { timeout: 10_000 });

    // Check table is visible
    const table = page.locator('[data-testid="admin-users-table"]');
    await expect(table).toBeVisible({ timeout: 10_000 });

    // Should show at least the admin user
    await expect(page.locator(`text=${ADMIN_EMAIL}`)).toBeVisible();
  });

  test("reader is redirected away from /admin", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', READER_EMAIL);
    await page.fill('input[type="password"]', READER_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 15_000 });

    // Try to access admin page
    await page.goto("/admin");
    // Should be redirected to home
    await page.waitForURL("/", { timeout: 10_000 });
  });

  test("workbench shows admin link for admin users", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 20_000 });

    // The server component may not have the latest session on first load — reload to sync
    await page.reload({ waitUntil: "networkidle" });

    const adminLink = page.locator('[data-testid="admin-link"]');
    await expect(adminLink).toBeVisible({ timeout: 10_000 });
  });

  test("workbench does not show admin link for reader users", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', READER_EMAIL);
    await page.fill('input[type="password"]', READER_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 15_000 });

    const adminLink = page.locator('[data-testid="admin-link"]');
    await expect(adminLink).not.toBeVisible({ timeout: 5_000 });
  });
});

test.describe("Pending approval page UI", () => {
  test.beforeEach(async () => {
    await resetPendingUserRole();
  });

  test("pending user is redirected to /pending-approval", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', PENDING_EMAIL);
    await page.fill('input[type="password"]', PENDING_PASSWORD);
    await page.click('button[type="submit"]');

    // Should redirect to pending-approval
    await page.waitForURL("/pending-approval", { timeout: 15_000 });
    await expect(page.locator("h1")).toHaveText("Pending Approval", { timeout: 10_000 });
  });

  test("pending page has check status and sign out buttons", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', PENDING_EMAIL);
    await page.fill('input[type="password"]', PENDING_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("/pending-approval", { timeout: 15_000 });

    await expect(page.locator('button:has-text("Check Status")')).toBeVisible();
    await expect(page.locator('button:has-text("Sign Out")')).toBeVisible();
  });
});
