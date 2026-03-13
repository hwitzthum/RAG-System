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
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
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
        error?: string;
        redirect?: string;
      };

      if (!serverResponse.ok) {
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
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });

      if (authError) {
        setError(authError.message);
        return;
      }

      const next = searchParams?.get("next") || serverData.redirect || "/";
      const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
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
      <h1 className="text-3xl font-bold text-zinc-900">Sign In</h1>
      <p className="mt-2 text-sm text-zinc-600">Enter your credentials to access the workspace.</p>

      {confirmed && (
        <p className="mt-4 rounded-lg bg-indigo-50 px-4 py-2.5 text-sm font-medium text-indigo-800">
          Email confirmed — you can now sign in.
        </p>
      )}
      {urlError === "suspended" && (
        <p className="mt-4 rounded-lg bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-700">
          Your account has been suspended. Contact an administrator.
        </p>
      )}
      {urlError === "rejected" && (
        <p className="mt-4 rounded-lg bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-700">
          Your account request has been declined. Contact an administrator if you believe this is an error.
        </p>
      )}
      {urlError === "confirmation_failed" && (
        <p className="mt-4 rounded-lg bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-700">
          Email confirmation failed or the link has expired. Please try signing up again.
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="email" className="block text-xs font-medium text-zinc-500">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-zinc-800 placeholder:text-zinc-400"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label htmlFor="password" className="block text-xs font-medium text-zinc-500">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-zinc-800 placeholder:text-zinc-400"
            placeholder="Enter your password"
          />
        </div>

        {error && <p className="text-sm text-rose-700" role="alert" aria-live="assertive">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg border border-zinc-900 bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-all duration-150 hover:bg-zinc-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Signing in..." : "Sign In"}
        </button>
      </form>

      <div className="mt-6 space-y-2 text-center text-sm text-zinc-600">
        <p>
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="font-semibold text-indigo-600 hover:text-indigo-700 hover:underline">
            Sign up
          </Link>
        </p>
        <p>
          <Link href="/reset-password" className="text-indigo-600 hover:text-indigo-700 hover:underline">
            Forgot your password?
          </Link>
        </p>
      </div>
    </>
  );
}

export default function LoginForm() {
  return (
    <Suspense fallback={<div className="p-4 text-center text-sm text-zinc-500">Loading...</div>}>
      <LoginFormInner />
    </Suspense>
  );
}
