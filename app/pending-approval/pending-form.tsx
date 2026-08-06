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
        setMessage(
          "Your account has been suspended. Contact an administrator.",
        );
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
      <h1 className="display-2">Pending Approval</h1>
      <p className="fg-secondary mt-4 text-sm leading-relaxed">
        Your account is pending approval by an administrator. You&apos;ll be
        able to access the workspace once your account is approved.
      </p>

      {message && (
        <p
          className={`callout mt-8 ${
            message.includes("approved")
              ? "callout-success"
              : message.includes("suspended")
                ? "callout-danger"
                : "callout-warning"
          }`}
        >
          {message}
        </p>
      )}

      <div className="mt-10 space-y-3">
        <button
          onClick={handleCheckStatus}
          disabled={checking}
          className="btn-primary w-full px-4 py-3 text-[11px] disabled:cursor-not-allowed"
        >
          {checking ? "Checking..." : "Check Status"}
        </button>

        <button
          onClick={handleSignOut}
          className="btn-secondary w-full px-4 py-3 text-[11px]"
        >
          Sign Out
        </button>
      </div>
    </>
  );
}
