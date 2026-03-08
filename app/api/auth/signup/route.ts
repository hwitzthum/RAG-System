import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/config/env";
import { logAuditEvent } from "@/lib/observability/audit";
import { consumeSharedRateLimit } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";

export const runtime = "nodejs";

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export async function POST(request: NextRequest) {
  const ipAddress = getClientIp(request);

  // Rate limit: 3 signups per hour per IP
  const rate = await consumeSharedRateLimit(`auth:signup:${ipAddress}`, 3, 3600);
  if (!rate.allowed) {
    logAuditEvent({
      action: "auth.signup",
      actorId: null,
      actorRole: "anonymous",
      outcome: "failure",
      resource: "auth",
      ipAddress,
      metadata: { reason: "rate_limited" },
    });
    return NextResponse.json(
      { error: "Too many signup attempts. Try again later.", retryAfterSeconds: rate.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  const parsed = signupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { email, password } = parsed.data;

  // Call Supabase Auth REST API for signup
  const signupResponse = await fetch(`${env.SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email, password }),
  });

  if (!signupResponse.ok) {
    const errorBody = await signupResponse.json().catch(() => ({ msg: "Signup failed" })) as { msg?: string };
    logAuditEvent({
      action: "auth.signup",
      actorId: null,
      actorRole: "anonymous",
      outcome: "failure",
      resource: "auth",
      ipAddress,
      metadata: { reason: "signup_failed", email },
    });
    return NextResponse.json(
      { error: errorBody.msg ?? "Signup failed" },
      { status: signupResponse.status },
    );
  }

  const signupData = (await signupResponse.json()) as { id?: string; user?: { id: string } };
  const userId = signupData.id ?? signupData.user?.id;

  // If this is the admin email, promote to admin immediately
  if (userId && env.ADMIN_EMAIL && email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase()) {
    try {
      const { getSupabaseAdminClient } = await import("@/lib/supabase/admin");
      const supabase = getSupabaseAdminClient();
      await supabase.auth.admin.updateUserById(userId, {
        app_metadata: { role: "admin" },
      });

      logAuditEvent({
        action: "auth.signup.admin_promote",
        actorId: userId,
        actorRole: "admin",
        outcome: "success",
        resource: "auth",
        ipAddress,
        metadata: { email },
      });
    } catch (error) {
      logAuditEvent({
        action: "auth.signup.admin_promote",
        actorId: userId,
        actorRole: "pending",
        outcome: "failure",
        resource: "auth",
        ipAddress,
        metadata: { reason: "admin_promote_failed", message: error instanceof Error ? error.message : "unknown" },
      });
    }
  }

  logAuditEvent({
    action: "auth.signup",
    actorId: userId ?? null,
    actorRole: "anonymous",
    outcome: "success",
    resource: "auth",
    ipAddress,
    metadata: { email },
  });

  return NextResponse.json({
    status: "ok",
    message: "Account created. An administrator will review your request.",
  });
}
