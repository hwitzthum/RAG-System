import type { NextRequest } from "next/server";

/**
 * Extracts the client IP address from the request.
 *
 * On Vercel, `x-real-ip` is set by the edge network and cannot be spoofed
 * by the client — always prefer it.
 *
 * `x-forwarded-for` is taken as the *rightmost* (last-appended) entry.
 * Vercel's edge appends the verified client IP at the end of this header;
 * leftmost entries can be injected by the client and are not trustworthy.
 */
export function getClientIp(request: NextRequest): string {
  // x-real-ip is set by Vercel's edge and is authoritative when present.
  const realIp = request.headers.get("x-real-ip");
  if (realIp?.trim()) return realIp.trim();

  // Fall back to the rightmost x-forwarded-for entry: Vercel appends the
  // verified client IP as the last entry; leftmost entries may have been
  // injected by the client and must not be trusted for rate-limit keys.
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const entries = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    const last = entries[entries.length - 1];
    if (last) return last;
  }

  return "unknown";
}
