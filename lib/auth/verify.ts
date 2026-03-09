import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { env } from "@/lib/config/env";

let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

function getRemoteJwks() {
  if (!jwksCache) {
    jwksCache = createRemoteJWKSet(new URL(env.AUTH_JWKS_URL));
  }

  return jwksCache;
}

function getExpectedIssuer(): string {
  return `${env.SUPABASE_URL}/auth/v1`;
}

export async function verifyAccessToken(token: string): Promise<JWTPayload> {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error("Empty access token");
  }

  const jwtOptions = {
    audience: "authenticated",
    issuer: getExpectedIssuer(),
  };

  if (env.SUPABASE_JWT_SECRET) {
    const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
    const verified = await jwtVerify(trimmed, secret, {
      algorithms: ["HS256"],
      ...jwtOptions,
    });
    return verified.payload;
  }

  const verified = await jwtVerify(trimmed, getRemoteJwks(), jwtOptions);
  return verified.payload;
}
