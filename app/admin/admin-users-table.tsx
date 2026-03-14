"use client";

import type { Role } from "@/lib/auth/types";
import { roleBadgeColor, type AdminUser, type ConfirmAction } from "@/app/admin/admin-panel.types";

export function AdminUsersTable(props: {
  users: AdminUser[];
  currentUserId: string;
  loading: boolean;
  actionLoading: string | null;
  onApprove(userId: string): void;
  onRequestConfirm(action: ConfirmAction): void;
}) {
  if (props.loading) {
    return (
      <div className="surface-card overflow-hidden rounded-2xl">
        <div className="fg-muted p-8 text-center text-sm">Loading users...</div>
      </div>
    );
  }

  return (
    <div className="surface-card overflow-hidden rounded-2xl">
      <table className="w-full text-sm" data-testid="admin-users-table">
        <thead>
          <tr className="surface-muted border-b border-[var(--border)]">
            <th className="fg-muted px-4 py-3 text-left text-xs font-medium">Email</th>
            <th className="fg-muted px-4 py-3 text-left text-xs font-medium">Role</th>
            <th className="fg-muted px-4 py-3 text-left text-xs font-medium">Created</th>
            <th className="fg-muted px-4 py-3 text-left text-xs font-medium">Last Sign In</th>
            <th className="fg-muted px-4 py-3 text-left text-xs font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {props.users.map((user) => (
            <tr key={user.id} className="border-b border-[var(--border)] last:border-0">
              <td className="fg-primary px-4 py-3 font-medium">{user.email ?? user.id.slice(0, 8)}</td>
              <td className="px-4 py-3">
                <span className={roleBadgeColor[user.role] ?? "badge badge-muted"}>
                  {user.role}
                </span>
              </td>
              <td className="fg-muted px-4 py-3">{new Date(user.created_at).toLocaleDateString()}</td>
              <td className="fg-muted px-4 py-3">
                {user.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleDateString() : "Never"}
              </td>
              <td className="px-4 py-3">
                <div className="flex gap-1.5">
                  {user.id === props.currentUserId ? (
                    <span className="fg-muted text-xs">You</span>
                  ) : (
                    <AdminUserActions
                      user={user}
                      actionLoading={props.actionLoading}
                      onApprove={props.onApprove}
                      onRequestConfirm={props.onRequestConfirm}
                    />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdminUserActions(props: {
  user: AdminUser;
  actionLoading: string | null;
  onApprove(userId: string): void;
  onRequestConfirm(action: ConfirmAction): void;
}) {
  const loading = props.actionLoading === props.user.id;

  return (
    <>
      {props.user.role === "pending" ? (
        <>
          <button
            onClick={() => props.onApprove(props.user.id)}
            disabled={loading}
            className="btn-primary active:scale-[0.98] rounded-lg px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
            data-testid={`approve-${props.user.id}`}
          >
            Approve
          </button>
          <button
            onClick={() =>
              props.onRequestConfirm({
                userId: props.user.id,
                action: "role",
                role: "rejected",
                label: `decline ${props.user.email ?? props.user.id}`,
              })
            }
            disabled={loading}
            className="btn-secondary active:scale-[0.98] rounded-lg px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
            data-testid={`decline-${props.user.id}`}
          >
            Decline
          </button>
        </>
      ) : null}

      {isSuspendableRole(props.user.role) ? (
        <button
          onClick={() =>
            props.onRequestConfirm({
              userId: props.user.id,
              action: "role",
              role: "suspended",
              label: `suspend ${props.user.email ?? props.user.id}`,
            })
          }
          disabled={loading}
          className="btn-danger active:scale-[0.98] rounded-lg px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
          data-testid={`suspend-${props.user.id}`}
        >
          Suspend
        </button>
      ) : null}

      {props.user.role === "suspended" ? (
        <button
          onClick={() =>
            props.onRequestConfirm({
              userId: props.user.id,
              action: "role",
              role: "reader",
              label: `reactivate ${props.user.email ?? props.user.id}`,
            })
          }
          disabled={loading}
          className="btn-primary active:scale-[0.98] rounded-lg px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
          data-testid={`reactivate-${props.user.id}`}
        >
          Reactivate
        </button>
      ) : null}

      <button
        onClick={() =>
          props.onRequestConfirm({
            userId: props.user.id,
            action: "delete",
            label: `permanently delete ${props.user.email ?? props.user.id}`,
          })
        }
        disabled={loading}
        className="btn-danger active:scale-[0.98] rounded-lg px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
        data-testid={`delete-${props.user.id}`}
      >
        Delete
      </button>
    </>
  );
}

function isSuspendableRole(role: Role): boolean {
  return role === "reader" || role === "admin";
}
