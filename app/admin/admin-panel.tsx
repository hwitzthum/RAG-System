"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { AdminRuntimeStatusResponse } from "@/lib/contracts/api";
import type { Role } from "@/lib/auth/types";
import { getCsrfToken } from "@/lib/security/csrf-client";
import { AdminConfirmDialog } from "@/app/admin/admin-confirm-dialog";
import { AdminRuntimeSignals } from "@/app/admin/admin-runtime-signals";
import { type AdminUser, type ConfirmAction } from "@/app/admin/admin-panel.types";
import { AdminUsersTable } from "@/app/admin/admin-users-table";

export default function AdminPanel({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState<AdminRuntimeStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

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

  const fetchRuntimeStatus = useCallback(async () => {
    setRuntimeLoading(true);
    setRuntimeError(null);
    try {
      const response = await fetch("/api/admin/runtime-status");
      if (!response.ok) throw new Error("Failed to fetch runtime status");
      const data = (await response.json()) as AdminRuntimeStatusResponse;
      setRuntimeStatus(data);
    } catch (err) {
      setRuntimeError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRuntimeLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRuntimeStatus();
  }, [fetchRuntimeStatus]);

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
      void deleteUser(confirmAction.userId);
    } else {
      void updateRole(confirmAction.userId, confirmAction.role);
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-zinc-900">User Management</h1>
        </div>
        <Link
          href="/"
          className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-50"
        >
          Back to Workbench
        </Link>
      </div>

      <AdminRuntimeSignals
        runtimeStatus={runtimeStatus}
        runtimeLoading={runtimeLoading}
        runtimeError={runtimeError}
        onRefresh={() => {
          void fetchRuntimeStatus();
          void fetchUsers();
        }}
        refreshDisabled={runtimeLoading || loading}
      />

      {error && (
        <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-rose-800">
          {error}
          <button onClick={() => setError(null)} className="ml-2 font-semibold underline">
            Dismiss
          </button>
        </div>
      )}

      <AdminConfirmDialog
        confirmAction={confirmAction}
        onConfirm={handleConfirm}
        onCancel={() => setConfirmAction(null)}
      />

      <AdminUsersTable
        users={users}
        currentUserId={currentUserId}
        loading={loading}
        actionLoading={actionLoading}
        onApprove={(userId) => {
          void updateRole(userId, "reader");
        }}
        onRequestConfirm={requestConfirm}
      />

      <div className="mt-4 flex justify-end">
        <button
          onClick={() => {
            void fetchUsers();
            void fetchRuntimeStatus();
          }}
          disabled={loading || runtimeLoading}
          className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-50 disabled:opacity-50"
        >
          Refresh All
        </button>
      </div>
    </div>
  );
}
