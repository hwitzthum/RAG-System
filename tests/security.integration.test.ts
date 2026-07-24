import assert from "node:assert/strict";
import test from "node:test";
import { resolveRoleFromClaims, hasRequiredRole } from "../lib/auth/claims";
import { consumeSharedRateLimit, createInMemoryRateLimiter } from "../lib/security/rate-limit";

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

// The Supabase-backed RPC path in consumeSharedRateLimit isn't reachable in this
// unit-test environment (no live Supabase credentials configured), which means the
// call always takes the catch/fallback branch below — exactly the "RPC is
// unreachable" scenario these two tests are about.
test("consumeSharedRateLimit fails closed by default when the Supabase RPC is unavailable", async () => {
  const decision = await consumeSharedRateLimit(`failclosed-default:${Date.now()}`, 5, 60);
  assert.equal(decision.allowed, false);
});

test("consumeSharedRateLimit only falls back to the in-memory limiter when a caller explicitly opts into failOpen: true", async () => {
  const key = `failopen-explicit:${Date.now()}`;
  const decision = await consumeSharedRateLimit(key, 5, 60, { failOpen: true });
  assert.equal(decision.allowed, true);
});
