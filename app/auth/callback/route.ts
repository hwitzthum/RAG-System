import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

function isSafeRedirectPath(next: string | null): next is string {
  if (!next) return false;
  try {
    const parsed = new URL(next, "http://localhost");
    return parsed.hostname === "localhost" && parsed.pathname.startsWith("/");
  } catch {
    return false;
  }
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

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error("[auth/callback] code exchange failed:", error.message);
    return NextResponse.redirect(`${origin}/login?error=confirmation_failed`);
  }

  // Determine where to send the user after exchange (safe redirect only)
  if (isSafeRedirectPath(next)) {
    return NextResponse.redirect(`${origin}${next}`);
  }

  // Signup confirmation: send to login with a success message
  return NextResponse.redirect(`${origin}/login?confirmed=true`);
}
