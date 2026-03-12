import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = new Set(["/login", "/signup", "/reset-password"]);

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

function isStaticAsset(pathname: string): boolean {
  return (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    pathname.endsWith(".ico") ||
    pathname.endsWith(".svg") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".jpg")
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isStaticAsset(pathname)) {
    return NextResponse.next();
  }

  // API routes handle their own auth via requireAuth / Bearer tokens.
  if (isApiPath(pathname)) {
    return NextResponse.next();
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          supabaseResponse = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            supabaseResponse.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Refresh session (sets updated cookies on supabaseResponse).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublicPath(pathname)) {
    // Allow pending-approval page for unauthenticated users (they'll redirect to login)
    if (pathname === "/pending-approval") {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = "/login";
      return NextResponse.redirect(loginUrl);
    }

    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (user) {
    const role = user.app_metadata?.role as string | undefined;

    // Suspended/rejected users: clear session and redirect to login
    if (role === "suspended" || role === "rejected") {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.searchParams.set("error", role);
      const response = NextResponse.redirect(loginUrl);
      // Clear Supabase auth cookies
      for (const cookie of request.cookies.getAll()) {
        if (cookie.name.startsWith("sb-") || cookie.name === "rag_access_token" || cookie.name === "__Host-rag_access_token") {
          response.cookies.set(cookie.name, "", { maxAge: 0, path: "/" });
        }
      }
      return response;
    }

    // Pending users: redirect to pending-approval unless already there
    if (role === "pending" && pathname !== "/pending-approval") {
      const pendingUrl = request.nextUrl.clone();
      pendingUrl.pathname = "/pending-approval";
      return NextResponse.redirect(pendingUrl);
    }

    // Non-pending users shouldn't be on the pending page
    if (role !== "pending" && pathname === "/pending-approval") {
      const homeUrl = request.nextUrl.clone();
      homeUrl.pathname = "/";
      return NextResponse.redirect(homeUrl);
    }

    // Admin page: only accessible by admins
    if (pathname.startsWith("/admin") && role !== "admin") {
      const homeUrl = request.nextUrl.clone();
      homeUrl.pathname = "/";
      return NextResponse.redirect(homeUrl);
    }

    // Redirect authenticated active users away from public auth pages
    if (isPublicPath(pathname)) {
      const homeUrl = request.nextUrl.clone();
      homeUrl.pathname = "/";
      return NextResponse.redirect(homeUrl);
    }

    // Sync the access token to our session cookie for API route auth.
    // After getUser() above, the Supabase SSR client has already refreshed
    // the session and set updated sb-* cookies on supabaseResponse.
    // Use getSession() from the *local* client (reads from already-refreshed
    // in-memory state — no additional network round-trip).
    const { data: sessionData } = await supabase.auth.getSession();
    if (sessionData.session?.access_token) {
      const isProduction = process.env.NODE_ENV === "production";
      const cookieName = isProduction ? "__Host-rag_access_token" : "rag_access_token";
      supabaseResponse.cookies.set({
        name: cookieName,
        value: sessionData.session.access_token,
        httpOnly: true,
        sameSite: "lax",
        secure: isProduction,
        path: "/",
      });
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
