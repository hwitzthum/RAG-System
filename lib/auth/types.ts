export type Role = "admin" | "reader" | "pending" | "suspended" | "rejected";

export type AuthUser = {
  id: string;
  role: Role;
  email: string | null;
};
