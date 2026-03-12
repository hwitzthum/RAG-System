"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-teal-900/85">Authentication</p>
        <h1 className="mt-1 text-3xl font-bold text-slate-900">Check Your Email</h1>
        <p className="mt-4 text-sm leading-relaxed text-slate-700">
          If an account exists for <strong>{email}</strong>, we&apos;ve sent a password reset link.
        </p>
        <a
          href="/login"
          className="mt-6 block w-full rounded-xl border border-slate-900 bg-slate-900 px-4 py-2.5 text-center text-sm font-semibold text-white transition hover:bg-slate-700"
        >
          Back to Sign In
        </a>
      </>
    );
  }

  if (mode === "success-set") {
    return (
      <>
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-teal-900/85">Authentication</p>
        <h1 className="mt-1 text-3xl font-bold text-slate-900">Password Updated</h1>
        <p className="mt-4 text-sm leading-relaxed text-slate-700">
          Your password has been set. Redirecting to the workbench…
        </p>
      </>
    );
  }

  if (mode === "set-password") {
    return (
      <>
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-teal-900/85">Authentication</p>
        <h1 className="mt-1 text-3xl font-bold text-slate-900">Set New Password</h1>
        <p className="mt-2 text-sm text-slate-600">Choose a new password for your account.</p>

        <form onSubmit={handleSetPassword} className="mt-6 space-y-4">
          <div>
            <label htmlFor="password" className="block text-xs font-semibold uppercase tracking-wide text-slate-600">
              New Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-xl border border-[#cdbca8] bg-white/95 px-3.5 py-2.5 text-sm text-slate-800"
            />
          </div>
          <div>
            <label htmlFor="confirm" className="block text-xs font-semibold uppercase tracking-wide text-slate-600">
              Confirm Password
            </label>
            <input
              id="confirm"
              type="password"
              required
              minLength={6}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="mt-1 w-full rounded-xl border border-[#cdbca8] bg-white/95 px-3.5 py-2.5 text-sm text-slate-800"
            />
          </div>

          {error && <p className="text-sm text-rose-700">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl border border-slate-900 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
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
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-teal-900/85">Authentication</p>
      <h1 className="mt-1 text-3xl font-bold text-slate-900">Reset Password</h1>
      <p className="mt-2 text-sm text-slate-600">Enter your email to receive a password reset link.</p>

      <form onSubmit={handleRequestReset} className="mt-6 space-y-4">
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

        {error && <p className="text-sm text-rose-700">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl border border-slate-900 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Sending…" : "Send Reset Link"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-600">
        <a href="/login" className="text-teal-800 hover:underline">
          Back to Sign In
        </a>
      </p>
    </>
  );
}
