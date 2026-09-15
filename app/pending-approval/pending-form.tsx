"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { getCsrfToken } from "@/lib/security/csrf-client";
import { describePendingStatus, type PendingStatusFeedback } from "./pending-status";

const CALLOUT_CLASS: Record<PendingStatusFeedback["tone"], string> = {
  success: "callout-success",
  warning: "callout-warning",
  danger: "callout-danger",
};

export default function PendingApprovalForm() {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState<PendingStatusFeedback | null>(null);

  async function handleCheckStatus() {
    setChecking(true);
    setFeedback(null);

    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase.auth.refreshSession();

      if (error) {
        setFeedback({
          approved: false,
          tone: "warning",
          message: "Unable to check status. Please try again.",
        });
        return;
      }

      const status = describePendingStatus(data.session?.user?.app_metadata?.role);
      setFeedback(status);

      if (status.approved) {
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

      {feedback && (
        <p className={`callout mt-8 ${CALLOUT_CLASS[feedback.tone]}`}>
          {feedback.message}
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
