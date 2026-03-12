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

async function setUserRole(userId: string, role: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({ app_metadata: { role } }),
  });
}

async function resetPendingUserRole(): Promise<void> {
  await setUserRole(PENDING_USER_ID, "pending");
}

/** Re-create the pending test user if it was deleted by a test */
async function ensurePendingUserExists(): Promise<void> {
  // Check if user exists
  const checkRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${PENDING_USER_ID}`, {
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
  });
  if (checkRes.ok) {
    // User exists, just reset role
    await resetPendingUserRole();
    return;
  }
  // User was deleted — re-create with the same ID
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({
      id: PENDING_USER_ID,
      email: PENDING_EMAIL,
      password: PENDING_PASSWORD,
      email_confirm: true,
      app_metadata: { role: "pending" },
    }),
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
    expect(response.headers()["cache-control"]).toBe("no-store");
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
    await ensurePendingUserExists();

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

    await resetPendingUserRole();
  });

  test("PATCH /api/admin/users/:id can decline a pending user", async ({ request }) => {
    await ensurePendingUserExists();

    const response = await request.patch(`/api/admin/users/${PENDING_USER_ID}`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      data: { role: "rejected" },
    });

    expect(response.ok()).toBe(true);
    const json = (await response.json()) as { role: string };
    expect(json.role).toBe("rejected");

    await resetPendingUserRole();
  });

  test("PATCH /api/admin/users/:id prevents self-action", async ({ request }) => {
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
    await setUserRole(PENDING_USER_ID, "reader");

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

    await resetPendingUserRole();
  });

  test("PATCH /api/admin/users/:id can reactivate a suspended user", async ({ request }) => {
    await setUserRole(PENDING_USER_ID, "suspended");

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

    await resetPendingUserRole();
  });

  test("PATCH /api/admin/users/:id rejects 'admin' as target role", async ({ request }) => {
    await ensurePendingUserExists();

    const response = await request.patch(`/api/admin/users/${PENDING_USER_ID}`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      data: { role: "admin" },
    });

    expect(response.status()).toBe(400);
    const json = (await response.json()) as { error: string };
    expect(json.error).toContain("Invalid");
  });

  test("DELETE /api/admin/users/:id deletes a user", async ({ request }) => {
    // Create a temporary user to delete
    const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({
        email: "e2e-delete-target@ragsystem.test",
        password: "DeleteMe123!",
        email_confirm: true,
        app_metadata: { role: "pending" },
      }),
    });
    const created = (await createRes.json()) as { id: string };
    const tempUserId = created.id;

    const response = await request.delete(`/api/admin/users/${tempUserId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(response.ok()).toBe(true);
    const json = (await response.json()) as { deleted: boolean; id: string };
    expect(json.deleted).toBe(true);
    expect(json.id).toBe(tempUserId);

    // Verify user is gone
    const listRes = await request.get("/api/admin/users", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const listJson = (await listRes.json()) as { users: Array<{ id: string }> };
    expect(listJson.users.find((u) => u.id === tempUserId)).toBeUndefined();
  });

  test("DELETE /api/admin/users/:id prevents self-deletion", async ({ request }) => {
    const listResponse = await request.get("/api/admin/users", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const listJson = (await listResponse.json()) as { users: Array<{ id: string; email: string }> };
    const adminUser = listJson.users.find((u) => u.email === ADMIN_EMAIL);
    expect(adminUser).toBeDefined();

    const response = await request.delete(`/api/admin/users/${adminUser!.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(response.status()).toBe(400);
    const json = (await response.json()) as { error: string };
    expect(json.error).toContain("own account");
  });
});

test.describe("Pending approval flow", () => {
  test.beforeEach(async () => {
    await ensurePendingUserExists();
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

test.describe("Rejected user flow", () => {
  test.afterEach(async () => {
    await ensurePendingUserExists();
  });

  test("rejected user sees error on login attempt", async ({ page }) => {
    await setUserRole(PENDING_USER_ID, "rejected");

    await page.goto("/login");
    await page.fill('input[type="email"]', PENDING_EMAIL);
    await page.fill('input[type="password"]', PENDING_PASSWORD);
    await page.click('button[type="submit"]');

    await expect(page.locator("text=declined")).toBeVisible({ timeout: 10_000 });
  });

  test("rejected user gets 403 on API endpoints", async ({ request }) => {
    await setUserRole(PENDING_USER_ID, "rejected");

    const rejectedToken = await getAccessToken(PENDING_EMAIL, PENDING_PASSWORD);
    const response = await request.post("/api/query", {
      headers: {
        Authorization: `Bearer ${rejectedToken}`,
        "Content-Type": "application/json",
      },
      data: { query: "test question", topK: 3 },
    });

    expect(response.status()).toBe(403);
  });
});

test.describe("Auth rate limiting", () => {
  test("login rate limit returns 429 after too many attempts", async ({ request }) => {
    const responses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const response = await request.post("/api/auth/login", {
        data: { email: "ratelimit-test@example.com", password: "wrongpassword" },
      });
      responses.push(response.status());
    }

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

    await page.goto("/admin");
    await expect(page.locator("h1")).toHaveText("User Management", { timeout: 10_000 });

    const table = page.locator('[data-testid="admin-users-table"]');
    await expect(table).toBeVisible({ timeout: 10_000 });

    await expect(page.locator(`text=${ADMIN_EMAIL}`)).toBeVisible();
  });

  test("admin sees correct buttons for pending users (Approve, Decline, Delete)", async ({ page }) => {
    await ensurePendingUserExists();

    await page.goto("/login");
    await page.fill('input[type="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 15_000 });

    await page.goto("/admin");
    await expect(page.locator('[data-testid="admin-users-table"]')).toBeVisible({ timeout: 10_000 });

    // Pending user should have Approve, Decline, and Delete buttons
    const approveBtn = page.locator(`[data-testid="approve-${PENDING_USER_ID}"]`);
    const declineBtn = page.locator(`[data-testid="decline-${PENDING_USER_ID}"]`);
    const deleteBtn = page.locator(`[data-testid="delete-${PENDING_USER_ID}"]`);
    await expect(approveBtn).toBeVisible();
    await expect(declineBtn).toBeVisible();
    await expect(deleteBtn).toBeVisible();

    // Should NOT have Suspend or Reactivate buttons
    const suspendBtn = page.locator(`[data-testid="suspend-${PENDING_USER_ID}"]`);
    const reactivateBtn = page.locator(`[data-testid="reactivate-${PENDING_USER_ID}"]`);
    await expect(suspendBtn).not.toBeVisible();
    await expect(reactivateBtn).not.toBeVisible();
  });

  test("reader is redirected away from /admin", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', READER_EMAIL);
    await page.fill('input[type="password"]', READER_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 15_000 });

    await page.goto("/admin");
    await page.waitForURL("/", { timeout: 10_000 });
  });

  test("workbench shows admin link for admin users", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 20_000 });

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
    await ensurePendingUserExists();
  });

  test("pending user is redirected to /pending-approval", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', PENDING_EMAIL);
    await page.fill('input[type="password"]', PENDING_PASSWORD);
    await page.click('button[type="submit"]');

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
