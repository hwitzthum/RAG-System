import { Trash2 } from "lucide-react";
import type { SidebarLeftProps } from "./types";
import { getDocumentDisplayName, formatTime, formatLatency } from "./types";
import { Skeleton } from "@/components/ui/skeleton";

export function SidebarLeft({
  documents,
  documentsLoading,
  canDeleteDocuments,
  deletingHistoryIds,
  queryDocumentScopeIds,
  toggleQueryDocumentScopeId,
  onDeleteDocument,
  onDeleteHistory,
  onRefreshDocuments,
  queryHistory,
  historyLoading,
  onRefreshHistory,
  onRestoreHistory,
  onNewConversation,
}: SidebarLeftProps) {
  return (
    <aside className="nav-surface hidden w-[280px] shrink-0 flex-col gap-8 overflow-y-auto border-r p-5 lg:flex">
      {/* New Conversation — the rail's single gold mark. */}
      <button
        type="button"
        onClick={onNewConversation}
        className="btn-primary w-full px-3 py-2.5 text-[11px]"
      >
        New Chat
      </button>

      {/* Query Timeline */}
      <section>
        <div className="flex items-center justify-between">
          <h3 className="section-label section-label-sub">Query Timeline</h3>
          <button
            type="button"
            onClick={onRefreshHistory}
            className="label-caps px-1.5 py-0.5 transition hover:text-[var(--text-primary)]"
          >
            Refresh
          </button>
        </div>
        {/* Capped so a long history cannot push the Documents list — and with
            it the per-document scope control — below the fold. */}
        <div className="seam-grid mt-4 max-h-[22rem] overflow-y-auto">
          {historyLoading ? (
            <div className="space-y-px">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : queryHistory.length === 0 ? (
            <p className="fg-muted px-3 py-3 text-xs">No history yet.</p>
          ) : (
            queryHistory.map((item) => (
              <div
                key={item.id}
                className="card-hover-accent flex items-start gap-1 pr-1 transition-colors hover:bg-[var(--emphasis-soft)]"
              >
                <button
                  type="button"
                  onClick={() => onRestoreHistory(item)}
                  className="w-full px-3 py-2.5 text-left"
                >
                  <p className="fg-primary truncate text-xs">{item.query}</p>
                  {/* Meta runs at the label's size and colour but without its
                      wide tracking — 0.2em wraps inside a 280px rail. */}
                  <p className="fg-muted mt-1 truncate text-[10px] tracking-[0.06em]">
                    {formatTime(item.createdAt)} ·{" "}
                    {formatLatency(item.latencyMs)}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteHistory(item.id)}
                  disabled={deletingHistoryIds.includes(item.id)}
                  className="fg-muted mt-2.5 p-1 transition hover:text-[var(--danger)] disabled:cursor-not-allowed disabled:opacity-50"
                  title="Delete chat"
                  aria-label={`Delete chat: ${item.query}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Document Library */}
      <section>
        <div className="flex items-center justify-between">
          <h3 className="section-label section-label-sub">Documents</h3>
          <button
            type="button"
            onClick={onRefreshDocuments}
            className="label-caps px-1.5 py-0.5 transition hover:text-[var(--text-primary)]"
          >
            Refresh
          </button>
        </div>
        <p className="fg-muted mt-2 text-[10px] tracking-[0.06em]">
          {queryDocumentScopeIds.length > 0
            ? `Search scoped to ${queryDocumentScopeIds.length} of ${documents.length}`
            : "Search covers all documents · click Scope to narrow"}
        </p>
        <div className="mt-3">
          {documentsLoading ? (
            <div className="space-y-px">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : documents.length === 0 ? (
            <p className="fg-muted text-xs">No documents ingested yet.</p>
          ) : (
            <ul className="seam-grid max-h-60 overflow-y-auto">
              {documents.map((doc) => {
                const displayName = getDocumentDisplayName(doc);
                const isScoped = queryDocumentScopeIds.includes(doc.id);
                const statusColor: Record<string, string> = {
                  ready: "tone-success",
                  processing: "tone-warning",
                  queued: "tone-muted",
                  failed: "tone-danger",
                };

                return (
                  <li
                    key={doc.id}
                    className="card-hover-accent flex items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-[var(--emphasis-soft)]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="fg-primary truncate" title={displayName}>
                        {displayName}
                      </p>
                      <span
                        className={`text-[10px] uppercase tracking-[0.14em] ${statusColor[doc.status] ?? "tone-muted"}`}
                      >
                        {doc.status}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => toggleQueryDocumentScopeId(doc.id)}
                        className={`badge transition ${isScoped ? "badge-active" : "badge-muted"}`}
                        title={
                          isScoped
                            ? "Remove from scope"
                            : "Add this document to scope"
                        }
                      >
                        {isScoped ? "Scoped" : "Scope"}
                      </button>
                      {canDeleteDocuments ? (
                        <button
                          type="button"
                          onClick={() => onDeleteDocument(doc.id)}
                          className="btn-danger p-1.5 transition"
                          title="Delete document"
                          aria-label={`Delete document: ${displayName}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </aside>
  );
}
