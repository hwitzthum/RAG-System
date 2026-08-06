"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { PanelLeft, PanelRight } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { getCsrfToken } from "@/lib/security/csrf-client";
import type { AuthUser } from "@/lib/auth/types";
import { ThemeSelector } from "@/components/theme/theme-selector";
import { RautakiWordmark } from "@/components/brand/rautaki-wordmark";

type AppNavProps = {
  user: AuthUser | null;
  onSignOut?: () => void;
  onToggleLeftPanel?: () => void;
  onToggleRightPanel?: () => void;
};

export function AppNav({
  user,
  onSignOut,
  onToggleLeftPanel,
  onToggleRightPanel,
}: AppNavProps) {
  const router = useRouter();

  async function handleSignOut() {
    await fetch("/api/auth/session", {
      method: "DELETE",
      headers: { "X-CSRF-Token": getCsrfToken() },
    });
    await getSupabaseBrowserClient()
      .auth.signOut()
      .catch(() => null);
    onSignOut?.();
    router.push("/login");
  }

  return (
    <>
      {/* Skip to content link */}
      <a
        href="#main-content"
        className="btn-secondary sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:bg-[var(--bg-surface)] focus:px-4 focus:py-2 focus:text-xs"
      >
        Skip to content
      </a>
      <nav className="nav-surface flex h-16 items-center justify-between border-b px-4 md:px-6">
        <div className="flex items-center gap-4">
          {/* Mobile sidebar toggles */}
          {onToggleLeftPanel && (
            <button
              type="button"
              onClick={onToggleLeftPanel}
              className="btn-ghost p-1.5 lg:hidden"
              aria-label="Toggle left panel"
            >
              <PanelLeft className="h-5 w-5" />
            </button>
          )}
          <Link href="/" className="flex items-center gap-4">
            <RautakiWordmark size="sm" />
            <span
              aria-hidden
              className="hidden h-5 w-px bg-[var(--border-strong)] sm:block"
            />
            <span className="label-caps hidden sm:block">RAG Workspace</span>
          </Link>
          {user?.role === "admin" && (
            <Link
              href="/admin"
              className="label-caps ml-2 transition hover:text-[var(--text-primary)]"
              data-testid="admin-link"
            >
              Admin
            </Link>
          )}
        </div>
        <div className="flex items-center gap-4 md:gap-6">
          <ThemeSelector className="hidden sm:inline-flex" />
          {user && (
            <>
              <span
                aria-hidden
                className="hidden h-5 w-px bg-[var(--border)] md:block"
              />
              <span className="label-caps">Signed in as {user.role}</span>
              <span className="fg-muted hidden text-xs xl:inline">
                {user.email}
              </span>
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="btn-secondary px-4 py-1.5 text-[11px]"
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
              className="btn-ghost p-1.5 lg:hidden"
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
