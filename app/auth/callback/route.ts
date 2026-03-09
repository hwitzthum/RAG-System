import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Supabase auth callback — exchanges a PKCE `code` for a session.
 *
 * Used as the redirect target for:
 *  - Email confirmation after signup  → redirects to /login?confirmed=true
 *  - Password recovery link           → redirects to /reset-password?verified=true
 *
 * The `next` query parameter overrides the default redirect target.
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

  // Determine where to send the user after exchange
  if (next) {
    return NextResponse.redirect(`${origin}${next}`);
  }

  if (type === "recovery") {
    // Password reset: send to reset-password page (session is now active, no code needed)
    return NextResponse.redirect(`${origin}/reset-password?verified=true`);
  }

  // Signup confirmation: send to login with a success message
  return NextResponse.redirect(`${origin}/login?confirmed=true`);
}
