"use client";

import type { AdminRuntimeStatusResponse } from "@/lib/contracts/api";

function signalBadge(passed: boolean): string {
  return passed
    ? "border-emerald-300 bg-emerald-50 text-emerald-800"
    : "border-rose-300 bg-rose-50 text-rose-800";
}

export function AdminRuntimeSignals(props: {
  runtimeStatus: AdminRuntimeStatusResponse | null;
  runtimeLoading: boolean;
  runtimeError: string | null;
  onRefresh(): void;
  refreshDisabled: boolean;
}) {
  const operationsCards = props.runtimeStatus
    ? [
        {
          label: "Queue",
          value: props.runtimeStatus.ingestionHealth.queuedCount,
          tone: "from-amber-100 to-white",
        },
        {
          label: "Processing",
          value: props.runtimeStatus.ingestionHealth.processingCount,
          tone: "from-sky-100 to-white",
        },
        {
          label: "Recent Progress",
          value: props.runtimeStatus.ingestionHealth.recentProgressCount,
          tone: "from-emerald-100 to-white",
        },
        {
          label: "Cache Entries",
          value: props.runtimeStatus.retrievalCache.totalEntries,
          tone: "from-rose-100 to-white",
        },
      ]
    : [];

  return (
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
            onClick={props.onRefresh}
            disabled={props.refreshDisabled}
            className="rounded-full border border-zinc-200 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            Refresh Signals
          </button>
        </div>
      </div>

      {props.runtimeError ? (
        <div className="px-5 py-4 text-sm text-rose-800">{props.runtimeError}</div>
      ) : props.runtimeLoading || !props.runtimeStatus ? (
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
                <span className="text-xs text-zinc-500">{new Date(props.runtimeStatus.generatedAt).toLocaleString()}</span>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-zinc-200 bg-white p-4" data-testid="admin-ingestion-contract-card">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-slate-700">Ingestion RPCs</span>
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${signalBadge(props.runtimeStatus.ingestionContract.passed)}`}>
                      {props.runtimeStatus.ingestionContract.passed ? "Ready" : "Missing"}
                    </span>
                  </div>
                  <p className="mt-3 text-xs text-zinc-500">
                    {props.runtimeStatus.ingestionContract.requiredRpcCount - props.runtimeStatus.ingestionContract.missingRpcNames.length}/
                    {props.runtimeStatus.ingestionContract.requiredRpcCount} available
                  </p>
                  {props.runtimeStatus.ingestionContract.missingRpcNames.length > 0 ? (
                    <p className="mt-2 font-mono text-[11px] text-rose-700">
                      {props.runtimeStatus.ingestionContract.missingRpcNames.join(", ")}
                    </p>
                  ) : null}
                </div>

                <div className="rounded-2xl border border-zinc-200 bg-white p-4" data-testid="admin-retrieval-contract-card">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-slate-700">Retrieval Cache RPCs</span>
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${signalBadge(props.runtimeStatus.retrievalCacheContract.passed)}`}>
                      {props.runtimeStatus.retrievalCacheContract.passed ? "Ready" : "Missing"}
                    </span>
                  </div>
                  <p className="mt-3 text-xs text-zinc-500">
                    {props.runtimeStatus.retrievalCacheContract.requiredRpcCount - props.runtimeStatus.retrievalCacheContract.missingRpcNames.length}/
                    {props.runtimeStatus.retrievalCacheContract.requiredRpcCount} available
                  </p>
                  {props.runtimeStatus.retrievalCacheContract.missingRpcNames.length > 0 ? (
                    <p className="mt-2 font-mono text-[11px] text-rose-700">
                      {props.runtimeStatus.retrievalCacheContract.missingRpcNames.join(", ")}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-zinc-200 bg-zinc-50/70 p-4" data-testid="admin-document-state-card">
              <h3 className="font-semibold text-slate-900">Document State</h3>
              <div className="mt-4 grid grid-cols-2 gap-3">
                {Object.entries(props.runtimeStatus.ingestionHealth.effectiveDocumentCounts).map(([status, count]) => (
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
                    {props.runtimeStatus.ingestionHealth.maxHeartbeatLagSeconds === null
                      ? "0s"
                      : `${props.runtimeStatus.ingestionHealth.maxHeartbeatLagSeconds}s`}
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    stale={props.runtimeStatus.ingestionHealth.staleProcessingCount}, lagging={props.runtimeStatus.ingestionHealth.laggingProcessingCount}
                  </p>
                </div>
                <div className="rounded-2xl border border-zinc-200 bg-white p-4">
                  <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">State Drift</div>
                  <div className="mt-2 text-2xl font-semibold text-slate-900">
                    {props.runtimeStatus.ingestionHealth.inconsistentDocumentCount + props.runtimeStatus.ingestionHealth.readyWithoutChunksCount}
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    mismatches={props.runtimeStatus.ingestionHealth.inconsistentDocumentCount}, ready-without-chunks=
                    {props.runtimeStatus.ingestionHealth.readyWithoutChunksCount}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {Object.entries(props.runtimeStatus.ingestionHealth.stageCounts).length === 0 ? (
                  <span className="text-sm text-zinc-500">No active processing stages.</span>
                ) : (
                  Object.entries(props.runtimeStatus.ingestionHealth.stageCounts).map(([stage, count]) => (
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
                    v{props.runtimeStatus.retrievalCache.currentRetrievalVersion}
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    current={props.runtimeStatus.retrievalCache.currentVersionEntries}, stale={props.runtimeStatus.retrievalCache.staleVersionEntries}
                  </p>
                </div>
                <div className="rounded-2xl border border-zinc-200 bg-white p-4">
                  <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">Expiry Pressure</div>
                  <div className="mt-2 text-2xl font-semibold text-slate-900">{props.runtimeStatus.retrievalCache.expiredEntries}</div>
                  <p className="mt-2 text-xs text-slate-500">expired entries waiting to be pruned</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
