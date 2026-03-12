"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Role } from "@/lib/auth/types";
import { getCsrfToken } from "@/lib/security/csrf-client";

type AdminUser = {
  id: string;
  email: string | null;
  role: Role;
  created_at: string;
  last_sign_in_at: string | null;
};

type ConfirmAction =
  | { userId: string; action: "role"; role: Role; label: string }
  | { userId: string; action: "delete"; label: string };

export default function AdminPanel({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    if (confirmAction) {
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
    }
  }, [confirmAction]);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/users");
      if (!response.ok) throw new Error("Failed to fetch users");
      const data = (await response.json()) as { users: AdminUser[] };
      setUsers(data.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  async function updateRole(userId: string, role: Role) {
    setActionLoading(userId);
    setConfirmAction(null);
    try {
      const response = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": getCsrfToken(),
        },
        body: JSON.stringify({ role }),
      });
      if (!response.ok) {
        const msg = await response.json().then((d) => (d as { error?: string }).error).catch(() => null);
        throw new Error(msg ?? "Failed to update role");
      }
      const updated = (await response.json()) as AdminUser;
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setActionLoading(null);
    }
  }

  async function deleteUser(userId: string) {
    setActionLoading(userId);
    setConfirmAction(null);
    try {
      const response = await fetch(`/api/admin/users/${userId}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": getCsrfToken() },
      });
      if (!response.ok) {
        const msg = await response.json().then((d) => (d as { error?: string }).error).catch(() => null);
        throw new Error(msg ?? "Failed to delete user");
      }
      setUsers((prev) => prev.filter((u) => u.id !== userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setActionLoading(null);
    }
  }

  function requestConfirm(ca: ConfirmAction) {
    setConfirmAction(ca);
  }

  function handleConfirm() {
    if (!confirmAction) return;
    if (confirmAction.action === "delete") {
      deleteUser(confirmAction.userId);
    } else {
      updateRole(confirmAction.userId, confirmAction.role);
    }
  }

  const roleBadgeColor: Record<Role, string> = {
    admin: "bg-purple-100 text-purple-800 border-purple-300",
    reader: "bg-emerald-100 text-emerald-800 border-emerald-300",
    pending: "bg-amber-100 text-amber-800 border-amber-300",
    suspended: "bg-rose-100 text-rose-800 border-rose-300",
    rejected: "bg-gray-100 text-gray-800 border-gray-300",
  };

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">User Management</h1>
        </div>
        <Link
          href="/"
          className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          Back to Workbench
        </Link>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-rose-800">
          {error}
          <button onClick={() => setError(null)} className="ml-2 font-semibold underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Confirmation dialog */}
      <dialog
        ref={dialogRef}
        className="rounded-xl border border-zinc-200 bg-white p-6 shadow-xl backdrop:bg-black/40"
        onClose={() => setConfirmAction(null)}
      >
        {confirmAction && (
          <div className="min-w-[320px]">
            <p className="text-sm text-zinc-900">
              Are you sure you want to <strong>{confirmAction.label}</strong>?
            </p>
            {confirmAction.action === "delete" && (
              <p className="mt-2 text-sm font-semibold text-rose-700">This action cannot be undone.</p>
            )}
            <div className="mt-4 flex gap-2">
              <button
                onClick={handleConfirm}
                className={`active:scale-[0.98] transition-all duration-150 rounded-lg px-3 py-1 text-xs font-semibold text-white ${
                  confirmAction.action === "delete" ? "bg-rose-700 hover:bg-rose-800" : "bg-amber-700 hover:bg-amber-800"
                }`}
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirmAction(null)}
                className="active:scale-[0.98] transition-all duration-150 rounded-lg border border-zinc-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </dialog>

      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">Loading users...</div>
        ) : (
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
              {users.map((u) => (
                <tr key={u.id} className="border-b border-zinc-100 last:border-0">
                  <td className="px-4 py-3 font-medium text-slate-800">{u.email ?? u.id.slice(0, 8)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${roleBadgeColor[u.role] ?? "bg-slate-100 text-slate-600 border-slate-300"}`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{new Date(u.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleDateString() : "Never"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1.5">
                      {u.id === currentUserId ? (
                        <span className="text-xs text-slate-400">You</span>
                      ) : (
                        <>
                          {/* Pending: Approve, Decline, Delete */}
                          {u.role === "pending" && (
                            <>
                              <button
                                onClick={() => updateRole(u.id, "reader")}
                                disabled={actionLoading === u.id}
                                className="active:scale-[0.98] transition-all duration-150 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                                data-testid={`approve-${u.id}`}
                              >
                                Approve
                              </button>
                              <button
                                onClick={() => requestConfirm({ userId: u.id, action: "role", role: "rejected", label: `decline ${u.email ?? u.id}` })}
                                disabled={actionLoading === u.id}
                                className="active:scale-[0.98] transition-all duration-150 rounded-lg bg-gray-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
                                data-testid={`decline-${u.id}`}
                              >
                                Decline
                              </button>
                            </>
                          )}
                          {/* Reader or Admin (not self): Suspend, Delete */}
                          {(u.role === "reader" || u.role === "admin") && (
                            <button
                              onClick={() => requestConfirm({ userId: u.id, action: "role", role: "suspended", label: `suspend ${u.email ?? u.id}` })}
                              disabled={actionLoading === u.id}
                              className="active:scale-[0.98] transition-all duration-150 rounded-lg bg-rose-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                              data-testid={`suspend-${u.id}`}
                            >
                              Suspend
                            </button>
                          )}
                          {/* Suspended: Reactivate, Delete */}
                          {u.role === "suspended" && (
                            <button
                              onClick={() => requestConfirm({ userId: u.id, action: "role", role: "reader", label: `reactivate ${u.email ?? u.id}` })}
                              disabled={actionLoading === u.id}
                              className="active:scale-[0.98] transition-all duration-150 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                              data-testid={`reactivate-${u.id}`}
                            >
                              Reactivate
                            </button>
                          )}
                          {/* Rejected: Delete only (no extra button) */}
                          {/* Delete button for all non-self users */}
                          <button
                            onClick={() => requestConfirm({ userId: u.id, action: "delete", label: `permanently delete ${u.email ?? u.id}` })}
                            disabled={actionLoading === u.id}
                            className="active:scale-[0.98] transition-all duration-150 rounded-lg border border-rose-300 bg-white px-2.5 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                            data-testid={`delete-${u.id}`}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-4 flex justify-end">
        <button
          onClick={fetchUsers}
          disabled={loading}
          className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}
