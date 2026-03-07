"use client";

import { useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export default function ResetForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const supabase = getSupabaseBrowserClient();
      const { error: authError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/login`,
      });

      if (authError) {
        setError(authError.message);
        return;
      }

      setSent(true);
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
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

  return (
    <>
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-teal-900/85">Authentication</p>
      <h1 className="mt-1 text-3xl font-bold text-slate-900">Reset Password</h1>
      <p className="mt-2 text-sm text-slate-600">Enter your email to receive a password reset link.</p>

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

        {error && <p className="text-sm text-rose-700">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl border border-slate-900 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Sending..." : "Send Reset Link"}
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