import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, getSessionCookieName } from "@/lib/auth/constants";
import { resolveEmailFromClaims, resolveRoleFromClaims } from "@/lib/auth/claims";
import type { AuthUser } from "@/lib/auth/types";
import { verifyAccessToken } from "@/lib/auth/verify";

export async function getServerSessionUser(): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  // Check production cookie name first, then fall back to legacy
  const token =
    cookieStore.get(getSessionCookieName(true))?.value ??
    cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!token) {
    return null;
  }

  try {
    const payload = await verifyAccessToken(token);
    const role = resolveRoleFromClaims(payload);

    if (!payload.sub || !role) {
      return null;
    }

    return {
      id: payload.sub,
      role,
      email: resolveEmailFromClaims(payload),
    };
  } catch {
    return null;
  }
}
