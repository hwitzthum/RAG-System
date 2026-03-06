import type { JWTPayload } from "jose";
import type { Role } from "@/lib/auth/types";

type ClaimsLike = JWTPayload & {
  app_metadata?: Record<string, unknown>;
  role?: string;
  email?: string;
};

export function resolveRoleFromClaims(payload: ClaimsLike): Role | null {
  const roleFromAppMetadata =
    payload.app_metadata && typeof payload.app_metadata.role === "string"
      ? payload.app_metadata.role
      : null;

  const roleCandidate = roleFromAppMetadata ?? payload.role ?? null;

  if (roleCandidate === "admin" || roleCandidate === "reader") {
    return roleCandidate;
  }

  return null;
}

export function resolveEmailFromClaims(payload: ClaimsLike): string | null {
  if (typeof payload.email === "string" && payload.email.length > 0) {
    return payload.email;
  }

  return null;
}

export function hasRequiredRole(role: Role, allowedRoles: Role[]): boolean {
  return allowedRoles.includes(role);
}
