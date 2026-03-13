"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type Mode = "request" | "set-password" | "success-request" | "success-set";

export default function ResetForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<Mode>("request");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Detect recovery code in URL (forwarded by /auth/callback)
  useEffect(() => {
    const code = searchParams?.get("code");

    async function handleCode() {
      if (!code) return;
      const supabase = getSupabaseBrowserClient();
      const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
      if (exchangeError) {
        setError("Invalid or expired reset link. Please request a new one.");
        return;
      }
      // Verify the session is actually present before showing the form
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        setError("Session could not be established. Please request a new reset link.");
        return;
      }
      setMode("set-password");
    }

    if (code) {
      void handleCode();
    }
  }, [searchParams]);

  // --- Request reset email ---
  async function handleRequestReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const { error: authError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?type=recovery`,
      });
      if (authError) {
        setError(authError.message);
        return;
      }
      setMode("success-request");
    } finally {
      setLoading(false);
    }
  }

  // --- Set new password ---
  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    setLoading(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError(updateError.message);
        return;
      }
      // Sign out the recovery session so the user does a clean login
      await supabase.auth.signOut();
      setMode("success-set");
      setTimeout(() => router.push("/login"), 2000);
    } finally {
      setLoading(false);
    }
  }

  // --- Render ---
  if (mode === "success-request") {
    return (
      <>
        <h1 className="text-3xl font-bold text-zinc-900">Check Your Email</h1>
        <p className="mt-4 text-sm leading-relaxed text-zinc-700">
          If an account exists for <strong>{email}</strong>, we&apos;ve sent a password reset link.
        </p>
        <Link
          href="/login"
          className="mt-6 block w-full rounded-lg border border-zinc-900 bg-zinc-900 px-4 py-2.5 text-center text-sm font-semibold text-white transition-all duration-150 hover:bg-zinc-800 active:scale-[0.98]"
        >
          Back to Sign In
        </Link>
      </>
    );
  }

  if (mode === "success-set") {
    return (
      <>
        <h1 className="text-3xl font-bold text-zinc-900">Password Updated</h1>
        <p className="mt-4 text-sm leading-relaxed text-zinc-700">
          Your password has been set. Redirecting to sign in…
        </p>
      </>
    );
  }

  if (mode === "set-password") {
    return (
      <>
        <h1 className="text-3xl font-bold text-zinc-900">Set New Password</h1>
        <p className="mt-2 text-sm text-zinc-600">Choose a new password for your account.</p>

        <form onSubmit={handleSetPassword} className="mt-6 space-y-4">
          <div>
            <label htmlFor="password" className="block text-xs font-medium text-zinc-500">
              New Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={6}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-zinc-800"
            />
          </div>
          <div>
            <label htmlFor="confirm" className="block text-xs font-medium text-zinc-500">
              Confirm Password
            </label>
            <input
              id="confirm"
              type="password"
              required
              minLength={6}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-zinc-800"
            />
          </div>

          {error && <p className="text-sm text-rose-700" role="alert" aria-live="assertive">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg border border-zinc-900 bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-all duration-150 hover:bg-zinc-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Updating…" : "Set Password"}
          </button>
        </form>
      </>
    );
  }

  // Default: request reset email
  return (
    <>
      <h1 className="text-3xl font-bold text-zinc-900">Reset Password</h1>
      <p className="mt-2 text-sm text-zinc-600">Enter your email to receive a password reset link.</p>

      <form onSubmit={handleRequestReset} className="mt-6 space-y-4">
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

        {error && <p className="text-sm text-rose-700" role="alert" aria-live="assertive">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg border border-zinc-900 bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-all duration-150 hover:bg-zinc-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Sending…" : "Send Reset Link"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-zinc-600">
        <Link href="/login" className="text-indigo-600 hover:text-indigo-700 hover:underline">
          Back to Sign In
        </Link>
      </p>
    </>
  );
}
