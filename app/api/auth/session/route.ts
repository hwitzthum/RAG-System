import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { resolveEmailFromClaims, resolveRoleFromClaims } from "@/lib/auth/claims";
import { verifyAccessToken } from "@/lib/auth/verify";
import { env } from "@/lib/config/env";
import { logAuditEvent } from "@/lib/observability/audit";
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

    const response = NextResponse.json({
      user: {
        id: payload.sub,
        role,
        email: resolveEmailFromClaims(payload),
      },
    });

    response.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: requestBody.accessToken,
      httpOnly: true,
      sameSite: "lax",
      secure: env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 8,
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
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;

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
  const response = NextResponse.json({ status: "ok" });
  const ipAddress = getClientIp(request);

  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
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
