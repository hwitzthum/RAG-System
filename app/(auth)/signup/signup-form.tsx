"use client";

import { useState } from "react";
import Link from "next/link";

export default function SignUpForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      // Call server-side signup for rate limiting and admin email check
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = (await response.json()) as { error?: string; message?: string };

      if (!response.ok) {
        setError(data.error ?? "Signup failed");
        return;
      }

      setSuccess(true);
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <>
        <h1 className="text-3xl font-bold text-zinc-900">Account Created</h1>
        <p className="mt-4 text-sm leading-relaxed text-zinc-700">
          Your account has been created. An administrator will review your request and approve your access.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-zinc-700">
          You&apos;ll be able to sign in once your account is approved.
        </p>
        <Link
          href="/login"
          className="mt-6 block w-full rounded-lg border border-zinc-900 bg-zinc-900 px-4 py-2.5 text-center text-sm font-semibold text-white transition-all duration-150 hover:bg-zinc-800 active:scale-[0.98]"
        >
          Go to Sign In
        </Link>
      </>
    );
  }

  return (
    <>
      <h1 className="text-3xl font-bold text-zinc-900">Create Account</h1>
      <p className="mt-2 text-sm text-zinc-600">Sign up to request access to the retrieval workspace.</p>

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
            minLength={6}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-zinc-800 placeholder:text-zinc-400"
            placeholder="At least 6 characters"
          />
        </div>

        {error && <p className="text-sm text-rose-700" role="alert" aria-live="assertive">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg border border-zinc-900 bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-all duration-150 hover:bg-zinc-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Creating account..." : "Sign Up"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-zinc-600">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-indigo-600 hover:text-indigo-700 hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
