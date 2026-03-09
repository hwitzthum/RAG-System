import { randomBytes, timingSafeEqual } from "node:crypto";
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

  const cookieBuffer = Buffer.from(cookieValue, "utf8");
  const headerBuffer = Buffer.from(headerValue, "utf8");

  if (cookieBuffer.length !== headerBuffer.length) {
    return false;
  }

  return timingSafeEqual(cookieBuffer, headerBuffer);
}
