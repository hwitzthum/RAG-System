import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/config/env";
import { logAuditEvent } from "@/lib/observability/audit";
import { consumeSharedRateLimit } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";

export const runtime = "nodejs";

const signupSchema = z.object({
  email: z.string().email(),
  // Enforce a minimum of 12 characters to reduce brute-force risk.
  // Supabase's own minimum (configured in the dashboard) should match.
  password: z.string().min(12),
});

export async function POST(request: NextRequest) {
  const ipAddress = getClientIp(request);

  // Parse body before consuming rate limit to avoid wasting attempts on invalid input
  const parsed = signupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { email, password } = parsed.data;

  // Rate limit: 3 signups per hour per IP AND per email (fail-closed for auth).
  // Keying on IP alone allows distributed attacks across many IPs; keying on
  // email alone allows an attacker to lock out a legitimate user's email address.
  // Both keys must pass.
  const rateIp = await consumeSharedRateLimit(`auth:signup:${ipAddress}`, 3, 3600, { failOpen: false });
  const rateEmail = await consumeSharedRateLimit(`auth:signup:email:${email.toLowerCase()}`, 3, 3600, { failOpen: false });
  const rate = rateIp.allowed ? rateEmail : rateIp;
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

  // Call Supabase Auth REST API for signup
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3001";
  const emailRedirectTo = `${appUrl}/auth/callback`;
  const signupResponse = await fetch(
    `${env.SUPABASE_URL}/auth/v1/signup?email_redirect_to=${encodeURIComponent(emailRedirectTo)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password }),
    },
  );

  if (!signupResponse.ok) {
    // Do NOT forward Supabase's raw error message — it can reveal whether the
    // email is already registered ("User already registered"), enabling email
    // enumeration attacks.  Log the real reason internally; return a generic
    // message to the client regardless of the failure cause.
    const errorBody = await signupResponse.json().catch(() => ({ msg: "Signup failed" })) as { msg?: string };
    logAuditEvent({
      action: "auth.signup",
      actorId: null,
      actorRole: "anonymous",
      outcome: "failure",
      resource: "auth",
      ipAddress,
      metadata: { reason: "signup_failed", supabaseMsg: errorBody.msg },
    });
    return NextResponse.json(
      { error: "Signup failed. Please check your details and try again." },
      { status: 400 },
    );
  }

  const signupData = (await signupResponse.json()) as { id?: string; user?: { id: string } };
  const userId = signupData.id ?? signupData.user?.id;

  // Admin role promotion happens in app/auth/callback/route.ts after the user
  // verifies their email. Promoting here (before verification) would allow
  // anyone who knows the admin email address to obtain admin access without
  // proving inbox control.

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
