export type PendingStatusFeedback = {
  approved: boolean;
  tone: "success" | "warning" | "danger";
  message: string;
};

/**
 * What "Check Status" on /pending-approval tells the user, for the role in
 * their freshly refreshed token. Suspended and declined accounts get the same
 * wording the login page shows after middleware bounces them there.
 */
export function describePendingStatus(role: unknown): PendingStatusFeedback {
  switch (role) {
    case "reader":
    case "admin":
      return {
        approved: true,
        tone: "success",
        message: "Your account has been approved! Redirecting...",
      };
    case "suspended":
      return {
        approved: false,
        tone: "danger",
        message: "Your account has been suspended. Contact an administrator.",
      };
    case "rejected":
      return {
        approved: false,
        tone: "danger",
        message:
          "Your account request has been declined. Contact an administrator if you believe this is an error.",
      };
    default:
      return {
        approved: false,
        tone: "warning",
        message: "Your account is still pending approval.",
      };
  }
}
