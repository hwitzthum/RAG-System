import type { NextRequest } from "next/server";

/**
 * Extracts the client IP address from the request.
 *
 * On Vercel, `x-real-ip` is set by the edge network and cannot be spoofed
 * by the client — always prefer it.
 *
 * `x-forwarded-for` is taken as the *leftmost* (originating) entry, which is
 * the client's address as seen by the first proxy.  Note that this header can
 * be prepended by intermediate proxies, so it should be treated as a best-effort
 * value for logging / rate-limiting rather than a security boundary.
 *
 * Rate-limit keys combine the user ID *and* IP so a spoofed IP alone is not
 * sufficient to bypass per-user limits for authenticated endpoints.
 */
export function getClientIp(request: NextRequest): string {
  // x-real-ip is set by Vercel's edge and is authoritative when present.
  const realIp = request.headers.get("x-real-ip");
  if (realIp?.trim()) return realIp.trim();

  // Fall back to the leftmost x-forwarded-for entry (original client).
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const entries = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    const first = entries[0];
    if (first) return first;
  }

  return "unknown";
}
