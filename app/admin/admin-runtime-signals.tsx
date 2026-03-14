"use client";

import type { AdminRuntimeStatusResponse } from "@/lib/contracts/api";

function signalBadge(passed: boolean): string {
  return passed ? "badge badge-success" : "badge badge-danger";
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
        },
        {
          label: "Processing",
          value: props.runtimeStatus.ingestionHealth.processingCount,
        },
        {
          label: "Recent Progress",
          value: props.runtimeStatus.ingestionHealth.recentProgressCount,
        },
        {
          label: "Cache Entries",
          value: props.runtimeStatus.retrievalCache.totalEntries,
        },
      ]
    : [];

  return (
    <div className="surface-card mb-6 overflow-hidden rounded-2xl" data-testid="admin-operations-panel">
      <div className="surface-muted border-b border-[var(--border)] px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="fg-muted text-xs font-semibold uppercase tracking-wider">Operations Strip</p>
            <h2 className="fg-primary mt-1 text-2xl font-semibold">Runtime Signals</h2>
            <p className="fg-secondary mt-1 max-w-2xl text-sm">
              Contract readiness, queue pressure, heartbeat drift, and retrieval cache state from the live app environment.
            </p>
          </div>
          <button
            onClick={props.onRefresh}
            disabled={props.refreshDisabled}
            className="btn-secondary rounded-2xl px-4 py-2 text-xs font-semibold uppercase tracking-wider disabled:opacity-50"
          >
            Refresh Signals
          </button>
        </div>
      </div>

      {props.runtimeError ? (
        <div className="tone-danger px-5 py-4 text-sm">{props.runtimeError}</div>
      ) : props.runtimeLoading || !props.runtimeStatus ? (
        <div className="fg-muted px-5 py-6 text-sm">Loading runtime signals...</div>
      ) : (
        <div className="space-y-5 px-5 py-5">
          <div className="grid gap-3 md:grid-cols-4">
            {operationsCards.map((card) => (
              <div key={card.label} className="surface-muted rounded-xl p-4">
                <div className="fg-muted text-xs font-semibold uppercase tracking-wider">{card.label}</div>
                <div className="fg-primary mt-2 text-3xl font-semibold">{card.value}</div>
              </div>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
            <div className="surface-muted rounded-xl p-4">
              <div className="flex items-center justify-between">
                <h3 className="fg-primary font-semibold">Contract Status</h3>
                <span className="fg-muted text-xs">{new Date(props.runtimeStatus.generatedAt).toLocaleString()}</span>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="surface-card rounded-xl p-4" data-testid="admin-ingestion-contract-card">
                  <div className="flex items-center justify-between gap-3">
                    <span className="fg-secondary text-sm font-medium">Ingestion RPCs</span>
                    <span className={signalBadge(props.runtimeStatus.ingestionContract.passed)}>
                      {props.runtimeStatus.ingestionContract.passed ? "Ready" : "Missing"}
                    </span>
                  </div>
                  <p className="fg-muted mt-3 text-xs">
                    {props.runtimeStatus.ingestionContract.requiredRpcCount - props.runtimeStatus.ingestionContract.missingRpcNames.length}/
                    {props.runtimeStatus.ingestionContract.requiredRpcCount} available
                  </p>
                  {props.runtimeStatus.ingestionContract.missingRpcNames.length > 0 ? (
                    <p className="tone-danger mt-2 font-mono text-xs">
                      {props.runtimeStatus.ingestionContract.missingRpcNames.join(", ")}
                    </p>
                  ) : null}
                </div>

                <div className="surface-card rounded-xl p-4" data-testid="admin-retrieval-contract-card">
                  <div className="flex items-center justify-between gap-3">
                    <span className="fg-secondary text-sm font-medium">Retrieval Cache RPCs</span>
                    <span className={signalBadge(props.runtimeStatus.retrievalCacheContract.passed)}>
                      {props.runtimeStatus.retrievalCacheContract.passed ? "Ready" : "Missing"}
                    </span>
                  </div>
                  <p className="fg-muted mt-3 text-xs">
                    {props.runtimeStatus.retrievalCacheContract.requiredRpcCount - props.runtimeStatus.retrievalCacheContract.missingRpcNames.length}/
                    {props.runtimeStatus.retrievalCacheContract.requiredRpcCount} available
                  </p>
                  {props.runtimeStatus.retrievalCacheContract.missingRpcNames.length > 0 ? (
                    <p className="tone-danger mt-2 font-mono text-xs">
                      {props.runtimeStatus.retrievalCacheContract.missingRpcNames.join(", ")}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="surface-muted rounded-xl p-4" data-testid="admin-document-state-card">
              <h3 className="fg-primary font-semibold">Document State</h3>
              <div className="mt-4 grid grid-cols-2 gap-3">
                {Object.entries(props.runtimeStatus.ingestionHealth.effectiveDocumentCounts).map(([status, count]) => (
                  <div key={status} className="surface-card rounded-xl p-3">
                    <div className="fg-muted text-xs font-semibold uppercase tracking-wider">{status}</div>
                    <div className="fg-primary mt-2 text-2xl font-semibold">{count}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
            <div className="surface-muted rounded-xl p-4" data-testid="admin-ingestion-health-card">
              <h3 className="fg-primary font-semibold">Ingestion Health</h3>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="surface-card rounded-xl p-4">
                  <div className="fg-muted text-xs uppercase tracking-wider">Heartbeat Lag</div>
                  <div className="fg-primary mt-2 text-2xl font-semibold">
                    {props.runtimeStatus.ingestionHealth.maxHeartbeatLagSeconds === null
                      ? "0s"
                      : `${props.runtimeStatus.ingestionHealth.maxHeartbeatLagSeconds}s`}
                  </div>
                  <p className="fg-muted mt-2 text-xs">
                    stale={props.runtimeStatus.ingestionHealth.staleProcessingCount}, lagging={props.runtimeStatus.ingestionHealth.laggingProcessingCount}
                  </p>
                </div>
                <div className="surface-card rounded-xl p-4">
                  <div className="fg-muted text-xs uppercase tracking-wider">State Drift</div>
                  <div className="fg-primary mt-2 text-2xl font-semibold">
                    {props.runtimeStatus.ingestionHealth.inconsistentDocumentCount + props.runtimeStatus.ingestionHealth.readyWithoutChunksCount}
                  </div>
                  <p className="fg-muted mt-2 text-xs">
                    mismatches={props.runtimeStatus.ingestionHealth.inconsistentDocumentCount}, ready-without-chunks=
                    {props.runtimeStatus.ingestionHealth.readyWithoutChunksCount}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {Object.entries(props.runtimeStatus.ingestionHealth.stageCounts).length === 0 ? (
                  <span className="fg-muted text-sm">No active processing stages.</span>
                ) : (
                  Object.entries(props.runtimeStatus.ingestionHealth.stageCounts).map(([stage, count]) => (
                    <span
                      key={stage}
                      className="badge badge-muted"
                    >
                      {stage}: {count}
                    </span>
                  ))
                )}
              </div>
            </div>

            <div className="surface-muted rounded-xl p-4" data-testid="admin-retrieval-cache-card">
              <h3 className="fg-primary font-semibold">Retrieval Cache</h3>
              <div className="mt-4 space-y-3">
                <div className="surface-card rounded-xl p-4">
                  <div className="fg-muted text-xs uppercase tracking-wider">Current Version</div>
                  <div className="fg-primary mt-2 text-2xl font-semibold">
                    v{props.runtimeStatus.retrievalCache.currentRetrievalVersion}
                  </div>
                  <p className="fg-muted mt-2 text-xs">
                    current={props.runtimeStatus.retrievalCache.currentVersionEntries}, stale={props.runtimeStatus.retrievalCache.staleVersionEntries}
                  </p>
                </div>
                <div className="surface-card rounded-xl p-4">
                  <div className="fg-muted text-xs uppercase tracking-wider">Expiry Pressure</div>
                  <div className="fg-primary mt-2 text-2xl font-semibold">{props.runtimeStatus.retrievalCache.expiredEntries}</div>
                  <p className="fg-muted mt-2 text-xs">expired entries waiting to be pruned</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
