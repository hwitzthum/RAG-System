import assert from "node:assert/strict";
import test from "node:test";
import { describePendingStatus } from "../app/pending-approval/pending-status";

test("describePendingStatus approves only access roles", () => {
  for (const role of ["reader", "admin"]) {
    const feedback = describePendingStatus(role);
    assert.equal(feedback.approved, true, role);
    assert.equal(feedback.tone, "success", role);
  }

  for (const role of ["pending", "suspended", "rejected", undefined, "unknown"]) {
    assert.equal(describePendingStatus(role).approved, false, String(role));
  }
});

test("describePendingStatus tells a declined user their request was declined", () => {
  const feedback = describePendingStatus("rejected");

  assert.equal(feedback.tone, "danger");
  assert.match(feedback.message, /declined/);
  assert.doesNotMatch(feedback.message, /pending/);
});

test("describePendingStatus keeps suspended and still-pending messages distinct", () => {
  assert.deepEqual(describePendingStatus("suspended"), {
    approved: false,
    tone: "danger",
    message: "Your account has been suspended. Contact an administrator.",
  });
  assert.deepEqual(describePendingStatus("pending"), {
    approved: false,
    tone: "warning",
    message: "Your account is still pending approval.",
  });
  assert.deepEqual(describePendingStatus(undefined), describePendingStatus("pending"));
});
