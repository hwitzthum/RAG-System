import { test, expect } from "@playwright/test";
import {
  READER_STATE_PATH,
  ADMIN_STATE_PATH,
  READER_TOKEN_PATH,
  ADMIN_TOKEN_PATH,
  loadToken,
  getTestAdminClient,
  fetchAccessToken,
} from "./auth-states";

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL!;
const READER_EMAIL = process.env.E2E_TEST_EMAIL!;
const PENDING_EMAIL = process.env.E2E_PENDING_EMAIL!;
const PENDING_PASSWORD = process.env.E2E_PENDING_PASSWORD!;
const PENDING_USER_ID = process.env.E2E_PENDING_USER_ID!;

async function setUserRole(userId: string, role: string): Promise<void> {
  const supabase = getTestAdminClient();
  const { error } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: { role },
  });
  if (error) throw new Error(`Failed to set role: ${error.message}`);
}

async function resetPendingUserRole(): Promise<void> {
  await setUserRole(PENDING_USER_ID, "pending");
}

/** Re-create the pending test user if it was deleted by a test */
async function ensurePendingUserExists(): Promise<void> {
  const supabase = getTestAdminClient();
  const { data, error } = await supabase.auth.admin.getUserById(PENDING_USER_ID);
  if (!error && data.user) {
    // User exists, just reset role
    await resetPendingUserRole();
    return;
  }

  // User was deleted — re-create with the same ID
  await supabase.auth.admin.createUser({
    email: PENDING_EMAIL,
    password: PENDING_PASSWORD,
    email_confirm: true,
    app_metadata: { role: "pending" },
  });
}

test.describe("Admin API", () => {
  let adminToken: string;

  test.beforeAll(async () => {
    adminToken = loadToken(ADMIN_TOKEN_PATH);
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
    const readerToken = loadToken(READER_TOKEN_PATH);
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
    const supabase = getTestAdminClient();

    // Clean up leftover user from previous runs
    const { data: existing } = await supabase.auth.admin.listUsers({ perPage: 100 });
    const leftover = existing?.users?.find((u) => u.email === "e2e-delete-target@ragsystem.test");
    if (leftover) {
      await supabase.auth.admin.deleteUser(leftover.id);
    }

    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email: "e2e-delete-target@ragsystem.test",
      password: "DeleteMe123!",
      email_confirm: true,
      app_metadata: { role: "pending" },
    });
    if (createErr) throw new Error(`Failed to create temp user: ${createErr.message}`);
    const tempUserId = created.user.id;

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
    const pendingToken = await fetchAccessToken(PENDING_EMAIL, PENDING_PASSWORD);
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
    const pendingToken = await fetchAccessToken(PENDING_EMAIL, PENDING_PASSWORD);
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

    const rejectedToken = await fetchAccessToken(PENDING_EMAIL, PENDING_PASSWORD);
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
    // Pre-seed the rate limit bucket via Supabase RPC to avoid hammering Supabase auth.
    // Login rate limit key format: auth:login:{ip}:{email} with limit=20/300s.
    // Dev server sees 127.0.0.1 or ::1 — we pre-fill for both possible IPs.
    const supabase = getTestAdminClient();
    const email = "ratelimit-test@example.com";
    const seedCalls = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].flatMap((ip) =>
      Array.from({ length: 18 }, () =>
        supabase.rpc("consume_rate_limit", {
          bucket_key_input: `auth:login:${ip}:${email}`,
          max_requests_input: 20,
          window_seconds_input: 300,
        }),
      ),
    );
    await Promise.all(seedCalls);

    // Only 2-4 real requests needed to exhaust remaining budget and trigger 429
    const responses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await request.post("/api/auth/login", {
        data: { email, password: "wrongpassword" },
      });
      responses.push(response.status());
    }

    expect(responses).toContain(429);
  });
});

test.describe("Admin page UI", () => {
  test.describe("admin user tests", () => {
    test.use({ storageState: ADMIN_STATE_PATH });

    test("admin can access /admin page and see user table", async ({ page }) => {
      await page.goto("/admin");
      await expect(page.locator("h1")).toHaveText("User Management", { timeout: 10_000 });

      const table = page.locator('[data-testid="admin-users-table"]');
      await expect(table).toBeVisible({ timeout: 10_000 });

      await expect(page.locator(`text=${ADMIN_EMAIL}`)).toBeVisible();
    });

    test("admin sees the runtime operations strip with contract and health cards", async ({ page }) => {
      await page.goto("/admin");

      const operationsPanel = page.locator('[data-testid="admin-operations-panel"]');
      await expect(operationsPanel).toBeVisible({ timeout: 10_000 });
      await expect(operationsPanel.getByRole("heading", { name: "Runtime Signals" })).toBeVisible();

      await expect(page.locator('[data-testid="admin-ingestion-contract-card"]')).toBeVisible();
      await expect(page.locator('[data-testid="admin-retrieval-contract-card"]')).toBeVisible();
      await expect(page.locator('[data-testid="admin-document-state-card"]')).toBeVisible();
      await expect(page.locator('[data-testid="admin-ingestion-health-card"]')).toBeVisible();
      await expect(page.locator('[data-testid="admin-retrieval-cache-card"]')).toBeVisible();
    });

    test("admin sees correct buttons for pending users (Approve, Decline, Delete)", async ({ page }) => {
      await ensurePendingUserExists();

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

    test("workbench shows admin link for admin users", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator("text=Response Workspace")).toBeVisible({ timeout: 10_000 });

      const adminLink = page.locator('[data-testid="admin-link"]');
      await expect(adminLink).toBeVisible({ timeout: 10_000 });
    });
  });

  test.describe("reader user tests", () => {
    test.use({ storageState: READER_STATE_PATH });

    test("reader is redirected away from /admin", async ({ page }) => {
      await page.goto("/admin");
      await page.waitForURL("/", { timeout: 10_000 });
    });

    test("workbench does not show admin link for reader users", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator("text=Response Workspace")).toBeVisible({ timeout: 10_000 });

      const adminLink = page.locator('[data-testid="admin-link"]');
      await expect(adminLink).not.toBeVisible({ timeout: 5_000 });
    });
  });
});

test.describe("Pending approval page UI", () => {
  test.beforeEach(async () => {
    await ensurePendingUserExists();
  });

  test("pending user is redirected to /pending-approval and sees controls", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', PENDING_EMAIL);
    await page.fill('input[type="password"]', PENDING_PASSWORD);
    await page.click('button[type="submit"]');

    await page.waitForURL("/pending-approval", { timeout: 45_000 });
    await expect(page.locator("h1")).toHaveText("Pending Approval", { timeout: 10_000 });
    await expect(page.locator('button:has-text("Check Status")')).toBeVisible();
    await expect(page.locator('button:has-text("Sign Out")')).toBeVisible();
  });
});
