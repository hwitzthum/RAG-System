import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, getSessionCookieName } from "@/lib/auth/constants";
import { resolveEmailFromClaims, resolveRoleFromClaims } from "@/lib/auth/claims";
import { verifyAccessToken } from "@/lib/auth/verify";
import { env } from "@/lib/config/env";
import { logAuditEvent } from "@/lib/observability/audit";
import { generateCsrfToken, getCsrfCookieName } from "@/lib/security/csrf";
import { getClientIp } from "@/lib/security/request";

export const runtime = "nodejs";

const sessionRequestSchema = z.object({
  accessToken: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const ipAddress = getClientIp(request);

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

export async function GET(request: NextRequest) {
  // Check both cookie names for backward compat
  const productionCookieName = getSessionCookieName(true);
  const token =
    request.cookies.get(productionCookieName)?.value ??
    request.cookies.get(SESSION_COOKIE_NAME)?.value;

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
    actorId: null,
    actorRole: "anonymous",
    outcome: "success",
    resource: "session",
    ipAddress,
  });

  return response;
}
