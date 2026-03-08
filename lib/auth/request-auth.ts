import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, getSessionCookieName } from "@/lib/auth/constants";
import { hasRequiredRole, resolveEmailFromClaims, resolveRoleFromClaims } from "@/lib/auth/claims";
import type { AuthUser, Role } from "@/lib/auth/types";
import { verifyAccessToken } from "@/lib/auth/verify";
import { env } from "@/lib/config/env";
import { logAuditEvent } from "@/lib/observability/audit";
import { getClientIp } from "@/lib/security/request";

export type AuthMethod = "bearer" | "cookie" | "dev_bypass";

export type AuthResult =
  | { ok: true; user: AuthUser; method: AuthMethod }
  | { ok: false; response: NextResponse<{ error: string }> };

export function extractBearerToken(request: NextRequest): { token: string; method: AuthMethod } | null {
  const authorization = request.headers.get("authorization");

  if (authorization && authorization.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    if (token) return { token, method: "bearer" };
  }

  // Check production cookie name first, then fall back to legacy
  const productionCookieName = getSessionCookieName(true);
  const cookieToken =
    request.cookies.get(productionCookieName)?.value ??
    request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (cookieToken) return { token: cookieToken, method: "cookie" };

  return null;
}

function resolveDevBypassUser(request: NextRequest): AuthUser | null {
  if (!env.AUTH_DEV_INSECURE_BYPASS || env.NODE_ENV === "production") {
    return null;
  }

  const roleHeader = request.headers.get("x-dev-user-role");
  const userIdHeader = request.headers.get("x-dev-user-id");
  const emailHeader = request.headers.get("x-dev-user-email");

  if (!roleHeader || !userIdHeader) {
    return null;
  }

  const validRoles: Role[] = ["admin", "reader", "pending", "suspended"];
  if (!validRoles.includes(roleHeader as Role)) {
    return null;
  }

  logAuditEvent({
    action: "auth.dev_bypass",
    actorId: userIdHeader,
    actorRole: roleHeader as Role,
    outcome: "success",
    resource: "session",
    ipAddress: getClientIp(request),
    metadata: { email: emailHeader },
  });

  return {
    id: userIdHeader,
    role: roleHeader as Role,
    email: emailHeader,
  };
}

export async function authenticateRequest(
  request: NextRequest,
): Promise<{ user: AuthUser; method: AuthMethod } | null> {
  const extracted = extractBearerToken(request);

  if (!extracted) {
    const devUser = resolveDevBypassUser(request);
    if (devUser) return { user: devUser, method: "dev_bypass" };
    return null;
  }

  try {
    const payload = await verifyAccessToken(extracted.token);
    const role = resolveRoleFromClaims(payload);

    if (!payload.sub || !role) {
      return null;
    }

    return {
      user: {
        id: payload.sub,
        role,
        email: resolveEmailFromClaims(payload),
      },
      method: extracted.method,
    };
  } catch {
    return null;
  }
}

export async function requireAuth(request: NextRequest, allowedRoles: Role[]): Promise<AuthResult> {
  const result = await authenticateRequest(request);

  if (!result) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  if (!hasRequiredRole(result.user.role, allowedRoles)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return {
    ok: true,
    user: result.user,
    method: result.method,
  };
}

/**
 * Like requireAuth but also validates CSRF token for cookie-based auth.
 * Bearer token auth is exempt from CSRF (not vulnerable to CSRF attacks).
 */
export async function requireAuthWithCsrf(request: NextRequest, allowedRoles: Role[]): Promise<AuthResult> {
  const authResult = await requireAuth(request, allowedRoles);

  if (!authResult.ok) {
    return authResult;
  }

  // Only validate CSRF for cookie-based auth
  if (authResult.method === "cookie") {
    const { validateCsrf } = await import("@/lib/security/csrf");
    if (!validateCsrf(request)) {
      return {
        ok: false,
        response: NextResponse.json({ error: "CSRF validation failed" }, { status: 403 }),
      };
    }
  }

  return authResult;
}
