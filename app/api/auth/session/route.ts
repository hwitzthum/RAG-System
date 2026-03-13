import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, getSessionCookieName } from "@/lib/auth/constants";
import { resolveEmailFromClaims, resolveRoleFromClaims } from "@/lib/auth/claims";
import type { Role } from "@/lib/auth/types";
import { verifyAccessToken } from "@/lib/auth/verify";
import { env } from "@/lib/config/env";
import { logAuditEvent } from "@/lib/observability/audit";
import { generateCsrfToken, getCsrfCookieName } from "@/lib/security/csrf";
import { consumeSharedRateLimit } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";

export const runtime = "nodejs";

const ACTIVE_ROLES = new Set<string>(["admin", "reader"]);

const sessionRequestSchema = z.object({
  accessToken: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const ipAddress = getClientIp(request);

  // Rate limit: 20 requests per 5 minutes per IP (fail-closed for auth)
  const rl = await consumeSharedRateLimit(`auth:session:${ipAddress}`, 20, 300, { failOpen: false });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let requestBody: z.infer<typeof sessionRequestSchema>;

  try {
    requestBody = sessionRequestSchema.parse(await request.json());
  } catch {
    logAuditEvent({
      action: "auth.session.create",
      actorId: null,
      actorRole: "anonymous",
      outcome: "failure",
      resource: "session",
      ipAddress,
      metadata: { reason: "invalid_request_body" },
    });

    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const payload = await verifyAccessToken(requestBody.accessToken);
    const role = resolveRoleFromClaims(payload);

    if (!payload.sub || !role) {
      throw new Error("Token missing required claims");
    }

    // Reject non-active roles (pending, suspended, rejected)
    if (!ACTIVE_ROLES.has(role)) {
      logAuditEvent({
        action: "auth.session.create",
        actorId: payload.sub,
        actorRole: role,
        outcome: "failure",
        resource: "session",
        ipAddress,
        metadata: { reason: "inactive_role", role },
      });
      return NextResponse.json({ error: "Account is not active" }, { status: 403 });
    }

    const isProduction = env.NODE_ENV === "production";
    const response = NextResponse.json({
      user: {
        id: payload.sub,
        role,
        email: resolveEmailFromClaims(payload),
      },
    });

    response.cookies.set({
      name: getSessionCookieName(isProduction),
      value: requestBody.accessToken,
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      path: "/",
    });

    // Set CSRF cookie
    response.cookies.set({
      name: getCsrfCookieName(),
      value: generateCsrfToken(),
      httpOnly: false,
      sameSite: "lax",
      secure: isProduction,
      path: "/",
    });

    logAuditEvent({
      action: "auth.session.create",
      actorId: payload.sub,
      actorRole: role,
      outcome: "success",
      resource: "session",
      ipAddress,
    });

    return response;
  } catch {
    logAuditEvent({
      action: "auth.session.create",
      actorId: null,
      actorRole: "anonymous",
      outcome: "failure",
      resource: "session",
      ipAddress,
      metadata: { reason: "token_verification_failed" },
    });

    return NextResponse.json({ error: "Invalid access token" }, { status: 401 });
  }
}

function getSessionToken(request: NextRequest): string | undefined {
  const productionCookieName = getSessionCookieName(true);
  return (
    request.cookies.get(productionCookieName)?.value ??
    request.cookies.get(SESSION_COOKIE_NAME)?.value
  );
}

export async function GET(request: NextRequest) {
  const token = getSessionToken(request);

  if (!token) {
    return NextResponse.json({ user: null }, { status: 200 });
  }

  try {
    const payload = await verifyAccessToken(token);
    const role = resolveRoleFromClaims(payload);

    if (!payload.sub || !role) {
      return NextResponse.json({ user: null }, { status: 200 });
    }

    return NextResponse.json({
      user: {
        id: payload.sub,
        role,
        email: resolveEmailFromClaims(payload),
      },
    });
  } catch {
    return NextResponse.json({ user: null }, { status: 200 });
  }
}

export async function DELETE(request: NextRequest) {
  const isProduction = env.NODE_ENV === "production";
  const response = NextResponse.json({ status: "ok" });
  const ipAddress = getClientIp(request);

  // Extract actor info from token payload (without full verification — token is being discarded)
  let actorId: string | null = null;
  let actorRole: Role | "anonymous" = "anonymous";
  const sessionToken = getSessionToken(request);

  if (sessionToken) {
    try {
      const parts = sessionToken.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
        if (payload.sub) {
          actorId = payload.sub;
          actorRole = resolveRoleFromClaims(payload) ?? "anonymous";
        }
      }
    } catch {
      // Malformed token — log as anonymous
    }
  }

  // Clear both cookie names
  response.cookies.set({
    name: getSessionCookieName(isProduction),
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    maxAge: 0,
  });

  // Also clear legacy cookie name if different
  if (getSessionCookieName(isProduction) !== SESSION_COOKIE_NAME) {
    response.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: "",
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      path: "/",
      maxAge: 0,
    });
  }

  // Clear CSRF cookie
  response.cookies.set({
    name: getCsrfCookieName(),
    value: "",
    httpOnly: false,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    maxAge: 0,
  });

  logAuditEvent({
    action: "auth.session.delete",
    actorId,
    actorRole,
    outcome: "success",
    resource: "session",
    ipAddress,
  });

  return response;
}
