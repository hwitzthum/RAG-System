import type { Role } from "@/lib/auth/types";

export type AdminUser = {
  id: string;
  email: string | null;
  role: Role;
  created_at: string;
  last_sign_in_at: string | null;
};

export type ConfirmAction =
  | { userId: string; action: "role"; role: Role; label: string }
  | { userId: string; action: "delete"; label: string };

export const roleBadgeColor: Record<Role, string> = {
  admin: "badge badge-accent",
  reader: "badge badge-success",
  pending: "badge badge-warning",
  suspended: "badge badge-danger",
  rejected: "badge badge-muted",
};
