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
  admin: "bg-purple-100 text-purple-800 border-purple-300",
  reader: "bg-emerald-100 text-emerald-800 border-emerald-300",
  pending: "bg-amber-100 text-amber-800 border-amber-300",
  suspended: "bg-rose-100 text-rose-800 border-rose-300",
  rejected: "bg-zinc-100 text-zinc-800 border-zinc-300",
};
