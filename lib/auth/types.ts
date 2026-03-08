export type Role = "admin" | "reader" | "pending" | "suspended";

export type AuthUser = {
  id: string;
  role: Role;
  email: string | null;
};
