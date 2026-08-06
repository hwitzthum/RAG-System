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
        <h1 className="display-2">Account Created</h1>
        <p className="callout mt-8">
          Check your inbox and click the confirmation link to verify your email — remember to look in your spam folder. You cannot sign in until your email is confirmed.
        </p>
        <p className="fg-secondary mt-4 text-sm leading-relaxed">
          Once your email is confirmed, an administrator will review your request and approve your access.
        </p>
        <p className="fg-secondary mt-2 text-sm leading-relaxed">
          You&apos;ll be able to sign in once both steps are complete.
        </p>
        <Link
          href="/login"
          className="btn-primary mt-10 block w-full px-4 py-3 text-center text-[11px]"
        >
          Go to Sign In
        </Link>
      </>
    );
  }

  return (
    <>
      <h1 className="display-2">Create Account</h1>
      <p className="fg-secondary mt-4 text-sm">Sign up to request access to the retrieval workspace.</p>

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
            minLength={6}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input-surface mt-2 w-full px-4 py-2.5 text-sm"
            placeholder="At least 6 characters"
          />
        </div>

        {error && <p className="tone-danger text-sm" role="alert" aria-live="assertive">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="btn-primary w-full px-4 py-3 text-[11px] disabled:cursor-not-allowed"
        >
          {loading ? "Creating account..." : "Sign Up"}
        </button>
      </form>

      <p className="fg-secondary mt-8 text-center text-sm">
        Already have an account?{" "}
        <Link href="/login" className="link-accent">
          Sign in
        </Link>
      </p>
    </>
  );
}
