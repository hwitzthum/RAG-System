"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AdminRuntimeStatusResponse } from "@/lib/contracts/api";
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
  const [runtimeStatus, setRuntimeStatus] = useState<AdminRuntimeStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
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

  const signalBadge = (passed: boolean) =>
    passed
      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
      : "border-rose-300 bg-rose-50 text-rose-800";

  const operationsCards = runtimeStatus
    ? [
        {
          label: "Queue",
          value: runtimeStatus.ingestionHealth.queuedCount,
          tone: "from-amber-100 to-white",
        },
        {
          label: "Processing",
          value: runtimeStatus.ingestionHealth.processingCount,
          tone: "from-sky-100 to-white",
        },
        {
          label: "Recent Progress",
          value: runtimeStatus.ingestionHealth.recentProgressCount,
          tone: "from-emerald-100 to-white",
        },
        {
          label: "Cache Entries",
          value: runtimeStatus.retrievalCache.totalEntries,
          tone: "from-rose-100 to-white",
        },
      ]
    : [];

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

      <div className="mb-6 overflow-hidden rounded-[28px] border border-zinc-200 bg-white shadow-sm" data-testid="admin-operations-panel">
        <div className="border-b border-zinc-100 bg-[linear-gradient(135deg,#f5f0e8,transparent_55%),linear-gradient(180deg,#ffffff,rgba(255,255,255,0.96))] px-5 py-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-zinc-500">Operations Strip</p>
              <h2 className="mt-1 font-serif text-2xl text-slate-900">Runtime Signals</h2>
              <p className="mt-1 max-w-2xl text-sm text-slate-600">
                Contract readiness, queue pressure, heartbeat drift, and retrieval cache state from the live app environment.
              </p>
            </div>
            <button
              onClick={() => {
                fetchRuntimeStatus();
                fetchUsers();
              }}
              disabled={runtimeLoading || loading}
              className="rounded-full border border-zinc-200 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              Refresh Signals
            </button>
          </div>
        </div>

        {runtimeError ? (
          <div className="px-5 py-4 text-sm text-rose-800">{runtimeError}</div>
        ) : runtimeLoading || !runtimeStatus ? (
          <div className="px-5 py-6 text-sm text-slate-500">Loading runtime signals...</div>
        ) : (
          <div className="space-y-5 px-5 py-5">
            <div className="grid gap-3 md:grid-cols-4">
              {operationsCards.map((card) => (
                <div key={card.label} className={`rounded-2xl border border-zinc-200 bg-gradient-to-br ${card.tone} p-4`}>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">{card.label}</div>
                  <div className="mt-2 text-3xl font-semibold text-slate-900">{card.value}</div>
                </div>
              ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
              <div className="rounded-2xl border border-zinc-200 bg-zinc-50/70 p-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-slate-900">Contract Status</h3>
                  <span className="text-xs text-zinc-500">{new Date(runtimeStatus.generatedAt).toLocaleString()}</span>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-zinc-200 bg-white p-4" data-testid="admin-ingestion-contract-card">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-slate-700">Ingestion RPCs</span>
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${signalBadge(runtimeStatus.ingestionContract.passed)}`}>
                        {runtimeStatus.ingestionContract.passed ? "Ready" : "Missing"}
                      </span>
                    </div>
                    <p className="mt-3 text-xs text-zinc-500">
                      {runtimeStatus.ingestionContract.requiredRpcCount - runtimeStatus.ingestionContract.missingRpcNames.length}/
                      {runtimeStatus.ingestionContract.requiredRpcCount} available
                    </p>
                    {runtimeStatus.ingestionContract.missingRpcNames.length > 0 && (
                      <p className="mt-2 font-mono text-[11px] text-rose-700">
                        {runtimeStatus.ingestionContract.missingRpcNames.join(", ")}
                      </p>
                    )}
                  </div>

                  <div className="rounded-2xl border border-zinc-200 bg-white p-4" data-testid="admin-retrieval-contract-card">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-slate-700">Retrieval Cache RPCs</span>
                      <span
                        className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${signalBadge(runtimeStatus.retrievalCacheContract.passed)}`}
                      >
                        {runtimeStatus.retrievalCacheContract.passed ? "Ready" : "Missing"}
                      </span>
                    </div>
                    <p className="mt-3 text-xs text-zinc-500">
                      {runtimeStatus.retrievalCacheContract.requiredRpcCount - runtimeStatus.retrievalCacheContract.missingRpcNames.length}/
                      {runtimeStatus.retrievalCacheContract.requiredRpcCount} available
                    </p>
                    {runtimeStatus.retrievalCacheContract.missingRpcNames.length > 0 && (
                      <p className="mt-2 font-mono text-[11px] text-rose-700">
                        {runtimeStatus.retrievalCacheContract.missingRpcNames.join(", ")}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-zinc-200 bg-zinc-50/70 p-4" data-testid="admin-document-state-card">
                <h3 className="font-semibold text-slate-900">Document State</h3>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  {Object.entries(runtimeStatus.ingestionHealth.effectiveDocumentCounts).map(([status, count]) => (
                    <div key={status} className="rounded-2xl border border-zinc-200 bg-white p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">{status}</div>
                      <div className="mt-2 text-2xl font-semibold text-slate-900">{count}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
              <div className="rounded-2xl border border-zinc-200 bg-zinc-50/70 p-4" data-testid="admin-ingestion-health-card">
                <h3 className="font-semibold text-slate-900">Ingestion Health</h3>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-zinc-200 bg-white p-4">
                    <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">Heartbeat Lag</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">
                      {runtimeStatus.ingestionHealth.maxHeartbeatLagSeconds === null
                        ? "0s"
                        : `${runtimeStatus.ingestionHealth.maxHeartbeatLagSeconds}s`}
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      stale={runtimeStatus.ingestionHealth.staleProcessingCount}, lagging={runtimeStatus.ingestionHealth.laggingProcessingCount}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-zinc-200 bg-white p-4">
                    <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">State Drift</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">
                      {runtimeStatus.ingestionHealth.inconsistentDocumentCount + runtimeStatus.ingestionHealth.readyWithoutChunksCount}
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      mismatches={runtimeStatus.ingestionHealth.inconsistentDocumentCount}, ready-without-chunks=
                      {runtimeStatus.ingestionHealth.readyWithoutChunksCount}
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {Object.entries(runtimeStatus.ingestionHealth.stageCounts).length === 0 ? (
                    <span className="text-sm text-zinc-500">No active processing stages.</span>
                  ) : (
                    Object.entries(runtimeStatus.ingestionHealth.stageCounts).map(([stage, count]) => (
                      <span
                        key={stage}
                        className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-medium text-slate-700"
                      >
                        {stage}: {count}
                      </span>
                    ))
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-zinc-200 bg-zinc-50/70 p-4" data-testid="admin-retrieval-cache-card">
                <h3 className="font-semibold text-slate-900">Retrieval Cache</h3>
                <div className="mt-4 space-y-3">
                  <div className="rounded-2xl border border-zinc-200 bg-white p-4">
                    <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">Current Version</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">
                      v{runtimeStatus.retrievalCache.currentRetrievalVersion}
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      current={runtimeStatus.retrievalCache.currentVersionEntries}, stale={runtimeStatus.retrievalCache.staleVersionEntries}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-zinc-200 bg-white p-4">
                    <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">Expiry Pressure</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">{runtimeStatus.retrievalCache.expiredEntries}</div>
                    <p className="mt-2 text-xs text-slate-500">expired entries waiting to be pruned</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
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
          onClick={() => {
            fetchUsers();
            fetchRuntimeStatus();
          }}
          disabled={loading || runtimeLoading}
          className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          Refresh All
        </button>
      </div>
    </div>
  );
}
