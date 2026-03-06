import assert from "node:assert/strict";
import test from "node:test";
import { resolveRoleFromClaims, hasRequiredRole } from "../lib/auth/claims";
import { createInMemoryRateLimiter } from "../lib/security/rate-limit";

test("resolveRoleFromClaims returns supported roles only", () => {
  assert.equal(resolveRoleFromClaims({ app_metadata: { role: "admin" } }), "admin");
  assert.equal(resolveRoleFromClaims({ role: "reader" }), "reader");
  assert.equal(resolveRoleFromClaims({ role: "owner" }), null);
});

test("hasRequiredRole enforces RBAC role lists", () => {
  assert.equal(hasRequiredRole("reader", ["reader", "admin"]), true);
  assert.equal(hasRequiredRole("admin", ["admin"]), true);
  assert.equal(hasRequiredRole("reader", ["admin"]), false);
});

test("in-memory rate limiter blocks requests after threshold", () => {
  const limiter = createInMemoryRateLimiter();

  const first = limiter.consume("user-1", 2, 60_000);
  const second = limiter.consume("user-1", 2, 60_000);
  const third = limiter.consume("user-1", 2, 60_000);

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
  assert.equal(third.remaining, 0);
  assert.ok(third.retryAfterSeconds >= 1);
});
