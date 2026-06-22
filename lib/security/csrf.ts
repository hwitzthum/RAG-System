import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export const CSRF_HEADER_NAME = "X-CSRF-Token";

export function getCsrfCookieName(): string {
  // __Host- prefix requires Secure (HTTPS), Path=/, no Domain — only works in production
  return process.env.NODE_ENV === "production" ? "__Host-csrf" : "csrf_token";
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

export function validateCsrf(request: NextRequest): boolean {
  const cookieName = getCsrfCookieName();
  const cookieValue = request.cookies.get(cookieName)?.value;
  const headerValue = request.headers.get(CSRF_HEADER_NAME);

  if (!cookieValue || !headerValue) {
    return false;
  }

  // Hash both values to a fixed-length digest before comparing so that
  // timingSafeEqual always runs the full comparison path regardless of
  // input lengths, preventing a length-based timing side channel.
  const key = "csrf-compare";
  const cookieDigest = createHmac("sha256", key).update(cookieValue).digest();
  const headerDigest = createHmac("sha256", key).update(headerValue).digest();

  return timingSafeEqual(cookieDigest, headerDigest);
}
