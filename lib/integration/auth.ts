// Bearer auth for the Kommandozentrale-facing endpoints (dashboard F2.4).
//
// These four routes are excluded from middleware.ts, because the dashboard has
// no Supabase session and never will: it is a machine, and it proves itself
// with a token issued for that purpose. The exclusion is only safe because of
// `configured()` — with DASHBOARD_TOKEN unset the routes answer 503 and do
// nothing, so an un-wired deployment has no open endpoint rather than an
// unauthenticated one.

import { timingSafeEqual } from "node:crypto";

/** Constant-time compare that does not leak length through an early return. */
function equal(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);

  if (bufferA.length !== bufferB.length) {
    timingSafeEqual(bufferA, bufferA);
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
}

/**
 * True when this deployment has been wired to a dashboard.
 *
 * Both halves matter: the token proves who is calling, and the service-account
 * credentials are the identity the call is made as. A token with no account
 * behind it would authenticate a caller this app cannot then represent.
 */
export function configured(): boolean {
  return Boolean(
    process.env.DASHBOARD_TOKEN?.trim() &&
    process.env.DASHBOARD_USER_EMAIL?.trim() &&
    process.env.DASHBOARD_USER_PASSWORD?.trim(),
  );
}

/**
 * Whether the caller proved it is the dashboard. One answer for a missing,
 * malformed or wrong token — nothing here should help a caller narrow it down.
 */
export function authenticated(request: Request): boolean {
  // Trimmed to match the incoming token, which is trimmed below. Without this,
  // a stray newline on DASHBOARD_TOKEN makes every comparison fail and locks
  // the dashboard out entirely, with the deliberately vague failure above
  // giving no hint as to why.
  const expected = process.env.DASHBOARD_TOKEN?.trim();
  if (!expected) return false;

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;

  const token = header.slice(7).trim();
  if (!token) return false;

  return equal(token, expected);
}
