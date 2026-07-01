import { createHmac, timingSafeEqual } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/config/env";
import { logAuditEvent } from "@/lib/observability/audit";
import { getClientIp } from "@/lib/security/request";

export const dynamic = "force-dynamic";

/**
 * Validates that a redirect target is a safe relative path on this origin.
 * Rejects absolute URLs, protocol-relative URLs (//evil.com), and any value
 * that contains a URL scheme (open-redirect vector).
 */
function isSafeRedirectPath(next: string | null): next is string {
  if (!next) return false;
  // Must start with a single slash (relative path)
  if (!next.startsWith("/")) return false;
  // Reject protocol-relative URLs (//evil.com treated as absolute by browsers)
  if (next.startsWith("//")) return false;
  // Reject paths that look like they contain a scheme after the slash
  if (/^\/[a-z][a-z0-9+\-.]*:/i.test(next)) return false;
  return true;
}

/**
 * Supabase auth callback.
 *
 * - Email confirmation: exchanges PKCE code server-side → /login?confirmed=true
 * - Password recovery: forwards code to browser client → /reset-password?code=...
 *   (browser must exchange it so updateUser() has a valid session)
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const type = searchParams.get("type"); // Supabase may pass e.g. "recovery"
  const next = searchParams.get("next");
  const ipAddress = getClientIp(request);

  if (!code) {
    // No code — just redirect to login
    return NextResponse.redirect(`${origin}/login`);
  }

  // For password recovery, forward the code to the browser client so it can
  // exchange it directly. This ensures the browser Supabase client has a valid
  // session for updateUser(). Exchanging server-side would put the session in
  // HTTP-only cookies invisible to the browser client, AND the middleware would
  // redirect the now-authenticated user away from /reset-password.
  const isRecovery = type === "recovery" || (next && next.includes("reset-password"));
  if (isRecovery) {
    return NextResponse.redirect(`${origin}/reset-password?code=${code}`);
  }

  // All other flows (email confirmation, etc.) — exchange server-side.
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        },
      },
    },
  );

  const { data: sessionData, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error("[auth/callback] code exchange failed:", error.message);
    return NextResponse.redirect(`${origin}/login?error=confirmation_failed`);
  }

  // Admin email promotion: only granted here, after the user has clicked the
  // verification link delivered to the admin inbox (proven email ownership).
  // The signup route deliberately does NOT promote — doing it there would allow
  // anyone who learns the ADMIN_EMAIL to obtain admin access before verification.
  const confirmedEmail = sessionData.user?.email;
  const confirmedUserId = sessionData.user?.id;
  if (
    confirmedEmail &&
    confirmedUserId &&
    env.ADMIN_EMAIL &&
    (() => {
      // Timing-safe comparison prevents an attacker from learning the admin email
      // address via response-time differences during the verification callback.
      // Both values are hashed to a fixed-length HMAC digest before comparison so
      // that timingSafeEqual always runs the full comparison regardless of input
      // length — a bare `a.length === b.length` short-circuit (the previous
      // pattern) leaks the admin email's length via response timing, the same
      // class of bug fixed for CSRF token comparison in lib/security/csrf.ts.
      const key = "admin-email-compare";
      const confirmedDigest = createHmac("sha256", key).update(confirmedEmail.toLowerCase()).digest();
      const adminDigest = createHmac("sha256", key).update((env.ADMIN_EMAIL ?? "").toLowerCase()).digest();
      return timingSafeEqual(confirmedDigest, adminDigest);
    })()
  ) {
    try {
      const { getSupabaseAdminClient } = await import("@/lib/supabase/admin");
      const adminClient = getSupabaseAdminClient();
      await adminClient.auth.admin.updateUserById(confirmedUserId, {
        app_metadata: { role: "admin" },
      });
      logAuditEvent({
        action: "auth.signup.admin_promote",
        actorId: confirmedUserId,
        actorRole: "admin",
        outcome: "success",
        resource: "auth",
        ipAddress,
        metadata: { email: confirmedEmail, via: "email_verification_callback" },
      });
    } catch (promoteError) {
      console.error("[auth/callback] admin promote failed:", promoteError);
      logAuditEvent({
        action: "auth.signup.admin_promote",
        actorId: confirmedUserId,
        actorRole: "pending",
        outcome: "failure",
        resource: "auth",
        ipAddress,
        metadata: {
          reason: "admin_promote_failed",
          message: promoteError instanceof Error ? promoteError.message : "unknown",
        },
      });
    }
  }

  // Determine where to send the user after exchange (safe redirect only)
  if (isSafeRedirectPath(next)) {
    return NextResponse.redirect(`${origin}${next}`);
  }

  // Signup confirmation: send to login with a success message
  return NextResponse.redirect(`${origin}/login?confirmed=true`);
}
