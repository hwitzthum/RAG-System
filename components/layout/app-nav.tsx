"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { getCsrfToken } from "@/lib/security/csrf-client";
import type { AuthUser } from "@/lib/auth/types";

type AppNavProps = {
  user: AuthUser | null;
  onSignOut?: () => void;
};

export function AppNav({ user, onSignOut }: AppNavProps) {
  const router = useRouter();

  async function handleSignOut() {
    await fetch("/api/auth/session", {
      method: "DELETE",
      headers: { "X-CSRF-Token": getCsrfToken() },
    });
    await getSupabaseBrowserClient().auth.signOut().catch(() => null);
    onSignOut?.();
    router.push("/login");
  }

  return (
    <nav className="flex h-14 items-center justify-between border-b border-zinc-200 bg-white px-4 md:px-6">
      <div className="flex items-center gap-6">
        <Link href="/" className="text-sm font-semibold text-zinc-900">
          RAG Workspace
        </Link>
        {user?.role === "admin" && (
          <Link
            href="/admin"
            className="text-sm text-zinc-500 transition hover:text-zinc-900"
            data-testid="admin-link"
          >
            Admin
          </Link>
        )}
      </div>
      {user && (
        <div className="flex items-center gap-4">
          <span className="text-xs text-zinc-500">
            Signed in as {user.role}
          </span>
          <span className="hidden text-xs text-zinc-400 sm:inline">{user.email}</span>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 active:scale-[0.98]"
            data-testid="sign-out-button"
          >
            Sign Out
          </button>
        </div>
      )}
    </nav>
  );
}
