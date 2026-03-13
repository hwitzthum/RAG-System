import type { NextRequest } from "next/server";

export function getClientIp(request: NextRequest): string {
  // Prefer x-real-ip (set by Vercel edge, not spoofable by the client).
  const realIp = request.headers.get("x-real-ip");
  if (realIp?.trim()) return realIp.trim();

  // Fall back to the rightmost x-forwarded-for entry (closest trusted proxy).
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const entries = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    const last = entries[entries.length - 1];
    if (last) return last;
  }

  return "unknown";
}
