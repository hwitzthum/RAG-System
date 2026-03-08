"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
      router.push(next);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-teal-900/85">Authentication</p>
      <h1 className="mt-1 text-3xl font-bold text-slate-900">Sign In</h1>
      <p className="mt-2 text-sm text-slate-600">Enter your credentials to access the workspace.</p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="email" className="block text-xs font-semibold uppercase tracking-wide text-slate-600">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-xl border border-[#cdbca8] bg-white/95 px-3.5 py-2.5 text-sm text-slate-800 placeholder:text-slate-400"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label htmlFor="password" className="block text-xs font-semibold uppercase tracking-wide text-slate-600">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-xl border border-[#cdbca8] bg-white/95 px-3.5 py-2.5 text-sm text-slate-800 placeholder:text-slate-400"
            placeholder="Enter your password"
          />
        </div>

        {error && <p className="text-sm text-rose-700">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl border border-slate-900 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Signing in..." : "Sign In"}
        </button>
      </form>

      <div className="mt-6 space-y-2 text-center text-sm text-slate-600">
        <p>
          Don&apos;t have an account?{" "}
          <a href="/signup" className="font-semibold text-teal-800 hover:underline">
            Sign up
          </a>
        </p>
        <p>
          <a href="/reset-password" className="text-teal-800 hover:underline">
            Forgot your password?
          </a>
        </p>
      </div>
    </>
  );
}

export default function LoginForm() {
  return (
    <Suspense fallback={<div className="p-4 text-center text-sm text-slate-500">Loading...</div>}>
      <LoginFormInner />
    </Suspense>
  );
}
