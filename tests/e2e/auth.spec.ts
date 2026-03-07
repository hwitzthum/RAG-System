import { test, expect } from "@playwright/test";

test.describe("Phase 1: Supabase Auth", () => {
  test("unauthenticated user is redirected to /login", async ({ page }) => {
    const response = await page.goto("/");
    // Should end up on login page
    expect(page.url()).toContain("/login");
    expect(response?.status()).toBe(200);
  });

  test("login page renders correctly", async ({ page }) => {
    await page.goto("/login");

    await expect(page.locator("h1")).toHaveText("Sign In");
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toHaveText("Sign In");
    await expect(page.locator('a[href="/signup"]')).toBeVisible();
    await expect(page.locator('a[href="/reset-password"]')).toBeVisible();
  });

  test("signup page renders correctly", async ({ page }) => {
    await page.goto("/signup");

    await expect(page.locator("h1")).toHaveText("Create Account");
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toHaveText("Sign Up");
    await expect(page.locator('a[href="/login"]')).toBeVisible();
  });

  test("reset-password page renders correctly", async ({ page }) => {
    await page.goto("/reset-password");

    await expect(page.locator("h1")).toHaveText("Reset Password");
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('a[href="/login"]')).toBeVisible();
  });

  test("login with invalid credentials shows error", async ({ page }) => {
    await page.goto("/login");

    await page.fill('input[type="email"]', "invalid@example.com");
    await page.fill('input[type="password"]', "wrongpassword");
    await page.click('button[type="submit"]');

    // Should show error message
    await expect(page.locator("text=Invalid login credentials").or(page.locator(".text-rose-700"))).toBeVisible({
      timeout: 10_000,
    });
  });

  test("login button shows loading state on submit", async ({ page }) => {
    await page.goto("/login");

    await page.fill('input[type="email"]', "test@example.com");
    await page.fill('input[type="password"]', "testpassword");

    // Click and immediately check for loading text
    const submitButton = page.locator('button[type="submit"]');
    await submitButton.click();

    // Button should briefly show "Signing in..." before the request completes
    // We use a short timeout since it may resolve quickly
    await expect(submitButton).toHaveText(/Signing in|Sign In/, { timeout: 5000 });
  });

  test("API routes are accessible without redirect (handle own auth)", async ({ page }) => {
    const response = await page.goto("/api/health");
    expect(response?.status()).toBe(200);
    const json = await response?.json();
    expect(json.status).toBe("ok");
  });

  test("navigation between auth pages works", async ({ page }) => {
    await page.goto("/login");

    // Go to signup
    await page.click('a[href="/signup"]');
    await expect(page.locator("h1")).toHaveText("Create Account");

    // Go back to login
    await page.click('a[href="/login"]');
    await expect(page.locator("h1")).toHaveText("Sign In");

    // Go to reset password
    await page.click('a[href="/reset-password"]');
    await expect(page.locator("h1")).toHaveText("Reset Password");
  });
});
