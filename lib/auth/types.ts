export type Role = "admin" | "reader";

export type AuthUser = {
  id: string;
  role: Role;
  email: string | null;
};
