// The dashboard's identity inside this app (Kommandozentrale F2.4).
//
// The dashboard is a machine with no Supabase session, but every route worth
// calling authenticates a user. So it signs in as a **service account** —
// kommandozentrale@rautaki.ch, a real Supabase user with
// app_metadata.role = "admin" — and uses the access token Supabase issues.
//
// Why a password grant rather than a self-signed token: this project signs
// tokens with an **asymmetric ES256 key** whose private half never leaves
// Supabase (see the JWKS at AUTH_JWKS_URL). Nothing here can mint a token the
// app will accept, and forcing the symmetric path by setting
// SUPABASE_JWT_SECRET would switch verification to HS256 for *every* request —
// breaking sign-in for the app's real users. The grant is the platform's own
// answer, and the token it returns is verified by exactly the same path a
// person's is.
//
// What this buys: the dashboard's requests travel the app's OWN routes —
// /api/query, /api/upload — instead of a parallel implementation beside them.
// Rate limits, prompt-injection defence, dedup, the ingestion queue and the
// audit trail all apply unchanged, and the audit log names the service account
// rather than a person who was not there.
//
// Admin because a reader answers only from documents shared with it, and a
// question that silently misses a document reads as the RAG being wrong rather
// than as a permission boundary working.

export class ServiceUserError extends Error {}

type Session = {
  accessToken: string;
  userId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
};

let cached: Session | null = null;
let inFlight: Promise<Session> | null = null;

/** Renew this long before expiry, so a call never starts on a dying token. */
const RENEW_MARGIN_MS = 5 * 60 * 1000;

function required(name: string): string {
  // Trimmed because these values bypass the Zod schema in lib/config/env.ts:
  // `anonKey` goes straight into an `apikey` header, where a stray newline is
  // an illegal header value, and `password` is compared by Supabase verbatim.
  // A whitespace-only value counts as missing rather than as a credential.
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ServiceUserError(
      `${name} is required for the dashboard integration`,
    );
  }
  return value;
}

async function signIn(): Promise<Session> {
  const supabaseUrl = required("SUPABASE_URL").replace(/\/$/, "");
  const anonKey = required("SUPABASE_ANON_KEY");
  const email = required("DASHBOARD_USER_EMAIL");
  const password = required("DASHBOARD_USER_PASSWORD");

  const response = await fetch(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: { apikey: anonKey, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    },
  );

  const payload = (await response.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    user?: { id?: string };
    error_description?: string;
    msg?: string;
  } | null;

  if (!response.ok || !payload?.access_token || !payload.user?.id) {
    throw new ServiceUserError(
      `The dashboard service account could not sign in: ${
        payload?.error_description ?? payload?.msg ?? response.status
      }`,
    );
  }

  return {
    accessToken: payload.access_token,
    userId: payload.user.id,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };
}

/**
 * The service account's session, signing in only when there is no usable one.
 *
 * A token lasts an hour; signing in per request would add a round trip to every
 * question for nothing. `inFlight` keeps two concurrent callers from opening two
 * sessions when the cache is cold.
 */
async function session(): Promise<Session> {
  if (cached && cached.expiresAt - RENEW_MARGIN_MS > Date.now()) {
    return cached;
  }

  if (!inFlight) {
    inFlight = signIn()
      .then((fresh) => {
        cached = fresh;
        return fresh;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return inFlight;
}

/** The Supabase user id the dashboard acts as — read from its own token. */
export async function serviceUserId(): Promise<string> {
  return (await session()).userId;
}

/**
 * Headers that make an in-process call look like the signed-in service account.
 *
 * Bearer rather than a cookie on purpose: this app exempts bearer auth from
 * CSRF (`requireAuthWithCsrf`), which is correct — a token in a header cannot be
 * replayed by a third-party page the way a cookie can.
 */
export async function serviceAuthHeaders(): Promise<Record<string, string>> {
  return { authorization: `Bearer ${(await session()).accessToken}` };
}

/** Drops the cached session. Exported for tests. */
export function forgetServiceSession(): void {
  cached = null;
  inFlight = null;
}
