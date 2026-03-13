"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { PanelLeft, PanelRight } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { getCsrfToken } from "@/lib/security/csrf-client";
import type { AuthUser } from "@/lib/auth/types";

type AppNavProps = {
  user: AuthUser | null;
  onSignOut?: () => void;
  onToggleLeftPanel?: () => void;
  onToggleRightPanel?: () => void;
};

export function AppNav({ user, onSignOut, onToggleLeftPanel, onToggleRightPanel }: AppNavProps) {
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
    <>
      {/* Skip to content link */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-indigo-600 focus:shadow-lg"
      >
        Skip to content
      </a>
      <nav className="flex h-14 items-center justify-between border-b border-zinc-200 bg-white px-4 md:px-6">
        <div className="flex items-center gap-4">
          {/* Mobile sidebar toggles */}
          {onToggleLeftPanel && (
            <button
              type="button"
              onClick={onToggleLeftPanel}
              className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-100 lg:hidden"
              aria-label="Toggle left panel"
            >
              <PanelLeft className="h-5 w-5" />
            </button>
          )}
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
        <div className="flex items-center gap-4">
          {user && (
            <>
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
            </>
          )}
          {/* Mobile right sidebar toggle */}
          {onToggleRightPanel && (
            <button
              type="button"
              onClick={onToggleRightPanel}
              className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-100 lg:hidden"
              aria-label="Toggle right panel"
            >
              <PanelRight className="h-5 w-5" />
            </button>
          )}
        </div>
      </nav>
    </>
  );
}
