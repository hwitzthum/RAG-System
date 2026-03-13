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
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
        <div className="p-8 text-center text-sm text-zinc-500">Loading users...</div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
      <table className="w-full text-sm" data-testid="admin-users-table">
        <thead>
          <tr className="border-b border-zinc-100 bg-zinc-50">
            <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500">Email</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500">Role</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500">Created</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500">Last Sign In</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500">Actions</th>
          </tr>
        </thead>
        <tbody>
          {props.users.map((user) => (
            <tr key={user.id} className="border-b border-zinc-100 last:border-0">
              <td className="px-4 py-3 font-medium text-zinc-800">{user.email ?? user.id.slice(0, 8)}</td>
              <td className="px-4 py-3">
                <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${roleBadgeColor[user.role] ?? "bg-zinc-100 text-zinc-600 border-zinc-300"}`}>
                  {user.role}
                </span>
              </td>
              <td className="px-4 py-3 text-zinc-500">{new Date(user.created_at).toLocaleDateString()}</td>
              <td className="px-4 py-3 text-zinc-500">
                {user.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleDateString() : "Never"}
              </td>
              <td className="px-4 py-3">
                <div className="flex gap-1.5">
                  {user.id === props.currentUserId ? (
                    <span className="text-xs text-zinc-400">You</span>
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
            className="active:scale-[0.98] transition-all duration-150 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
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
            className="active:scale-[0.98] transition-all duration-150 rounded-lg bg-zinc-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-zinc-700 disabled:opacity-50"
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
          className="active:scale-[0.98] transition-all duration-150 rounded-lg bg-rose-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
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
          className="active:scale-[0.98] transition-all duration-150 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
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
        className="active:scale-[0.98] transition-all duration-150 rounded-lg border border-rose-300 bg-white px-2.5 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
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
