import type { NextRequest } from "next/server";

/**
 * Extracts a Bearer token string from the Authorization header.
 * Returns null if no valid Bearer token is present.
 */
export function extractBearerTokenString(request: NextRequest): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization || !authorization.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}
