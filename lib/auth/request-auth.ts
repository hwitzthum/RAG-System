import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { hasRequiredRole, resolveEmailFromClaims, resolveRoleFromClaims } from "@/lib/auth/claims";
import type { AuthUser, Role } from "@/lib/auth/types";
import { verifyAccessToken } from "@/lib/auth/verify";
import { env } from "@/lib/config/env";

export type AuthResult =
  | { ok: true; user: AuthUser }
  | { ok: false; response: NextResponse<{ error: string }> };

export function extractBearerToken(request: NextRequest): string | null {
  const authorization = request.headers.get("authorization");

  if (authorization && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  return request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
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

  if (roleHeader !== "admin" && roleHeader !== "reader") {
    return null;
  }

  return {
    id: userIdHeader,
    role: roleHeader,
    email: emailHeader,
  };
}

export async function authenticateRequest(request: NextRequest): Promise<AuthUser | null> {
  const token = extractBearerToken(request);

  if (!token) {
    return resolveDevBypassUser(request);
  }

  try {
    const payload = await verifyAccessToken(token);
    const role = resolveRoleFromClaims(payload);

    if (!payload.sub || !role) {
      return null;
    }

    return {
      id: payload.sub,
      role,
      email: resolveEmailFromClaims(payload),
    };
  } catch {
    return null;
  }
}

export async function requireAuth(request: NextRequest, allowedRoles: Role[]): Promise<AuthResult> {
  const user = await authenticateRequest(request);

  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  if (!hasRequiredRole(user.role, allowedRoles)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return {
    ok: true,
    user,
  };
}
