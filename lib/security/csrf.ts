import { randomBytes } from "node:crypto";
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

  // Constant-time comparison
  if (cookieValue.length !== headerValue.length) {
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < cookieValue.length; i++) {
    mismatch |= cookieValue.charCodeAt(i) ^ headerValue.charCodeAt(i);
  }

  return mismatch === 0;
}
