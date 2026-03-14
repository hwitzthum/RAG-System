"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { getCsrfToken } from "@/lib/security/csrf-client";

export default function PendingApprovalForm() {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleCheckStatus() {
    setChecking(true);
    setMessage(null);

    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase.auth.refreshSession();

      if (error) {
        setMessage("Unable to check status. Please try again.");
        return;
      }

      const role = data.session?.user?.app_metadata?.role;

      if (role === "reader" || role === "admin") {
        setMessage("Your account has been approved! Redirecting...");
        // Set the refreshed token as session cookie
        if (data.session?.access_token) {
          await fetch("/api/auth/session", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": getCsrfToken(),
            },
            body: JSON.stringify({ accessToken: data.session.access_token }),
          });
        }
        setTimeout(() => {
          router.push("/");
          router.refresh();
        }, 1000);
      } else if (role === "suspended") {
        setMessage("Your account has been suspended. Contact an administrator.");
      } else {
        setMessage("Your account is still pending approval.");
      }
    } finally {
      setChecking(false);
    }
  }

  async function handleSignOut() {
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    await fetch("/api/auth/session", { method: "DELETE" });
    router.push("/login");
    router.refresh();
  }

  return (
    <>
      <h1 className="fg-primary text-3xl font-bold">Pending Approval</h1>
      <p className="fg-secondary mt-4 text-sm leading-relaxed">
        Your account is pending approval by an administrator. You&apos;ll be able to access the workspace once your account is approved.
      </p>

      {message && (
        <p className={`mt-4 text-sm font-medium ${
          message.includes("approved")
            ? "tone-success"
            : message.includes("suspended")
              ? "tone-danger"
              : "tone-warning"
        }`}>
          {message}
        </p>
      )}

      <div className="mt-6 space-y-3">
        <button
          onClick={handleCheckStatus}
          disabled={checking}
          className="btn-primary w-full rounded-2xl px-4 py-2.5 text-sm font-semibold active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {checking ? "Checking..." : "Check Status"}
        </button>

        <button
          onClick={handleSignOut}
          className="btn-secondary w-full rounded-2xl px-4 py-2.5 text-sm font-semibold active:scale-[0.98]"
        >
          Sign Out
        </button>
      </div>
    </>
  );
}
