"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { PanelLeft, PanelRight } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { getCsrfToken } from "@/lib/security/csrf-client";
import type { AuthUser } from "@/lib/auth/types";
import { ThemeSelector } from "@/components/theme/theme-selector";

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
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-[var(--bg-elevated)] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[var(--accent-strong)] focus:shadow-lg"
      >
        Skip to content
      </a>
      <nav className="nav-surface flex h-14 items-center justify-between border-b px-4 md:px-6">
        <div className="flex items-center gap-4">
          {/* Mobile sidebar toggles */}
          {onToggleLeftPanel && (
            <button
              type="button"
              onClick={onToggleLeftPanel}
              className="btn-ghost rounded-lg p-1.5 lg:hidden"
              aria-label="Toggle left panel"
            >
              <PanelLeft className="h-5 w-5" />
            </button>
          )}
          <Link href="/" className="fg-primary text-sm font-semibold">
            RAG Workspace
          </Link>
          {user?.role === "admin" && (
            <Link
              href="/admin"
              className="fg-muted text-sm transition hover:text-[var(--text-primary)]"
              data-testid="admin-link"
            >
              Admin
            </Link>
          )}
        </div>
        <div className="flex items-center gap-3 md:gap-4">
          <ThemeSelector className="hidden sm:inline-flex" />
          {user && (
            <>
              <span className="fg-secondary text-xs">
                Signed in as {user.role}
              </span>
              <span className="fg-muted hidden text-xs xl:inline">{user.email}</span>
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="btn-secondary rounded-lg px-3 py-1.5 text-xs font-medium active:scale-[0.98]"
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
              className="btn-ghost rounded-lg p-1.5 lg:hidden"
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
