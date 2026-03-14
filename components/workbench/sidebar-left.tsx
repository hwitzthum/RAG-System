import { Trash2 } from "lucide-react";
import type { SidebarLeftProps } from "./types";
import { getDocumentDisplayName, formatTime, formatLatency } from "./types";
import { Skeleton } from "@/components/ui/skeleton";

export function SidebarLeft({
  documents,
  documentsLoading,
  canDeleteDocuments,
  queryDocumentScopeIds,
  toggleQueryDocumentScopeId,
  onDeleteDocument,
  onRefreshDocuments,
  queryHistory,
  historyLoading,
  onRefreshHistory,
  onRestoreHistory,
  onNewConversation,
}: SidebarLeftProps) {
  return (
    <aside className="nav-surface hidden w-[280px] shrink-0 flex-col gap-4 overflow-y-auto border-r p-4 lg:flex">
      {/* New Conversation */}
      <button
        type="button"
        onClick={onNewConversation}
        className="btn-primary w-full rounded-2xl px-3 py-2 text-sm font-medium active:scale-[0.98]"
      >
        + New Chat
      </button>

      {/* Query Timeline */}
      <section>
        <div className="flex items-center justify-between">
          <h3 className="fg-secondary text-xs font-medium">Query Timeline</h3>
          <button
            type="button"
            onClick={onRefreshHistory}
            className="btn-ghost rounded px-1.5 py-0.5 text-xs font-medium"
          >
            Refresh
          </button>
        </div>
        <div className="mt-2 space-y-1.5">
          {historyLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : queryHistory.length === 0 ? (
            <p className="fg-muted text-xs">No history yet.</p>
          ) : (
            queryHistory.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => onRestoreHistory(item)}
                className="surface-muted w-full rounded-2xl px-3 py-2 text-left hover:border-[var(--accent-border)] hover:bg-[var(--bg-elevated)]"
              >
                <p className="fg-secondary truncate text-xs font-medium">{item.query}</p>
                <p className="fg-muted mt-0.5 text-xs">
                  {formatTime(item.createdAt)} | {formatLatency(item.latencyMs)}
                </p>
              </button>
            ))
          )}
        </div>
      </section>

      {/* Document Library */}
      <section>
        <div className="flex items-center justify-between">
          <h3 className="fg-secondary text-xs font-medium">Documents</h3>
          <button
            type="button"
            onClick={onRefreshDocuments}
            className="btn-ghost rounded px-1.5 py-0.5 text-xs font-medium"
          >
            Refresh
          </button>
        </div>
        <div className="mt-2 space-y-1.5">
          {documentsLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : documents.length === 0 ? (
            <p className="fg-muted text-xs">No documents ingested yet.</p>
          ) : (
            <ul className="max-h-60 space-y-1.5 overflow-y-auto">
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
                  <li key={doc.id} className="surface-muted flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-xs">
                    <div className="min-w-0 flex-1">
                      <p className="fg-secondary truncate font-medium" title={displayName}>
                        {displayName}
                      </p>
                      <span className={`text-xs font-medium ${statusColor[doc.status] ?? "tone-muted"}`}>
                        {doc.status}
                      </span>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => toggleQueryDocumentScopeId(doc.id)}
                        className={`rounded-full px-2 py-0.5 text-xs font-medium transition ${
                          isScoped
                            ? "badge badge-accent"
                            : "badge badge-muted"
                        }`}
                        title={isScoped ? "Remove from scope" : "Add this document to scope"}
                      >
                        {isScoped ? "Scoped" : "Scope"}
                      </button>
                      {canDeleteDocuments ? (
                        <button
                          type="button"
                          onClick={() => onDeleteDocument(doc.id)}
                          className="btn-danger rounded p-1"
                          title="Delete document"
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
