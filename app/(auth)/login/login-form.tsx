"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

function LoginFormInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);

    try {
      // Step 1: Server-side login for rate limiting and role checks
      const serverResponse = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const serverData = (await serverResponse.json()) as {
        status?: string;
        code?: string;
        error?: string;
        redirect?: string;
      };

      if (!serverResponse.ok) {
        // An unconfirmed email is actionable guidance, not a credential
        // failure — surface it as a notice so the user knows to check their
        // inbox instead of retrying a password that was never the problem.
        if (serverData.code === "email_not_confirmed") {
          setNotice(
            serverData.error ??
              "Please confirm your email address before signing in.",
          );
          return;
        }
        setError(serverData.error ?? "Login failed");
        return;
      }

      if (serverData.status === "pending") {
        // Still sign in via Supabase to create browser session for pending page
        const supabase = getSupabaseBrowserClient();
        await supabase.auth.signInWithPassword({ email, password });
        router.push("/pending-approval");
        return;
      }

      // Step 2: Create Supabase browser session (sets cookies for middleware)
      const supabase = getSupabaseBrowserClient();
      const { error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError) {
        setError(authError.message);
        return;
      }

      const next = searchParams?.get("next") || serverData.redirect || "/";
      const safeNext =
        next.startsWith("/") && !next.startsWith("//") ? next : "/";
      router.push(safeNext);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  const confirmed = searchParams?.get("confirmed") === "true";
  const urlError = searchParams?.get("error");

  return (
    <>
      <h1 className="display-2">Sign In</h1>
      <p className="fg-secondary mt-4 text-sm">
        Enter your credentials to access the workspace.
      </p>

      {confirmed && (
        <p className="callout callout-success mt-8">
          Email confirmed — you can now sign in.
        </p>
      )}
      {urlError === "suspended" && (
        <p className="callout callout-danger mt-8">
          Your account has been suspended. Contact an administrator.
        </p>
      )}
      {urlError === "rejected" && (
        <p className="callout callout-danger mt-8">
          Your account request has been declined. Contact an administrator if
          you believe this is an error.
        </p>
      )}
      {urlError === "confirmation_failed" && (
        <p className="callout callout-danger mt-8">
          Email confirmation failed or the link has expired. Please try signing
          up again.
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-10 space-y-6">
        <div>
          <label htmlFor="email" className="label-caps block">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input-surface mt-2 w-full px-4 py-2.5 text-sm"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label htmlFor="password" className="label-caps block">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input-surface mt-2 w-full px-4 py-2.5 text-sm"
            placeholder="Enter your password"
          />
        </div>

        {notice && (
          <p className="callout" role="status" aria-live="polite">
            {notice}
          </p>
        )}

        {error && (
          <p className="tone-danger text-sm" role="alert" aria-live="assertive">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="btn-primary w-full px-4 py-3 text-[11px] disabled:cursor-not-allowed"
        >
          {loading ? "Signing in..." : "Sign In"}
        </button>
      </form>

      <div className="fg-secondary mt-6 space-y-2 text-center text-sm">
        <p>
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="link-accent">
            Sign up
          </Link>
        </p>
        <p>
          <Link href="/reset-password" className="link-accent">
            Forgot your password?
          </Link>
        </p>
      </div>
    </>
  );
}

export default function LoginForm() {
  return (
    <Suspense
      fallback={
        <div className="fg-muted p-4 text-center text-sm">Loading...</div>
      }
    >
      <LoginFormInner />
    </Suspense>
  );
}
