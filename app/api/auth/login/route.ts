import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookieName } from "@/lib/auth/constants";
import { env } from "@/lib/config/env";
import { logAuditEvent } from "@/lib/observability/audit";
import { generateCsrfToken, getCsrfCookieName } from "@/lib/security/csrf";
import { consumeSharedRateLimit } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";

export const runtime = "nodejs";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const ipAddress = getClientIp(request);

  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { email, password } = parsed.data;

  // Rate limit: 20 attempts per 5 minutes per IP+email combo
  const rate = await consumeSharedRateLimit(`auth:login:${ipAddress}:${email.toLowerCase()}`, 20, 300);
  if (!rate.allowed) {
    logAuditEvent({
      action: "auth.login",
      actorId: null,
      actorRole: "anonymous",
      outcome: "failure",
      resource: "auth",
      ipAddress,
      metadata: { reason: "rate_limited" },
    });
    return NextResponse.json(
      { error: "Too many login attempts. Try again later.", retryAfterSeconds: rate.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  // Call Supabase Auth REST API
  const tokenResponse = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email, password }),
  });

  if (!tokenResponse.ok) {
    logAuditEvent({
      action: "auth.login",
      actorId: null,
      actorRole: "anonymous",
      outcome: "failure",
      resource: "auth",
      ipAddress,
      metadata: { reason: "invalid_credentials", email },
    });
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token: string;
    user: {
      id: string;
      email: string;
      app_metadata?: { role?: string };
    };
  };

  const role = tokenData.user.app_metadata?.role ?? "pending";

  // Check for pending/suspended status
  if (role === "pending") {
    logAuditEvent({
      action: "auth.login",
      actorId: tokenData.user.id,
      actorRole: "pending",
      outcome: "success",
      resource: "auth",
      ipAddress,
      metadata: { status: "pending" },
    });

    const response = NextResponse.json({ status: "pending", redirect: "/pending-approval" });
    // Still set the session cookie so middleware can detect the pending user
    const isProduction = env.NODE_ENV === "production";
    response.cookies.set({
      name: getSessionCookieName(isProduction),
      value: tokenData.access_token,
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      path: "/",
      maxAge: 60 * 60, // 1 hour
    });
    return response;
  }

  if (role === "suspended") {
    logAuditEvent({
      action: "auth.login",
      actorId: tokenData.user.id,
      actorRole: "suspended",
      outcome: "failure",
      resource: "auth",
      ipAddress,
      metadata: { reason: "account_suspended" },
    });
    return NextResponse.json({ error: "Your account has been suspended. Contact an administrator." }, { status: 403 });
  }

  // Successful login with active role
  const isProduction = env.NODE_ENV === "production";
  const csrfToken = generateCsrfToken();

  const response = NextResponse.json({
    status: "ok",
    user: {
      id: tokenData.user.id,
      email: tokenData.user.email,
      role,
    },
    redirect: "/",
  });

  // Set session cookie
  response.cookies.set({
    name: getSessionCookieName(isProduction),
    value: tokenData.access_token,
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    maxAge: 60 * 60, // 1 hour
  });

  // Set CSRF cookie (readable by client JS)
  response.cookies.set({
    name: getCsrfCookieName(),
    value: csrfToken,
    httpOnly: false,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    maxAge: 60 * 60, // 1 hour
  });

  logAuditEvent({
    action: "auth.login",
    actorId: tokenData.user.id,
    actorRole: role as "admin" | "reader",
    outcome: "success",
    resource: "auth",
    ipAddress,
  });

  return response;
}
