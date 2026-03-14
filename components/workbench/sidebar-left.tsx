import { Trash2 } from "lucide-react";
import type { SidebarLeftProps } from "./types";
import { getDocumentDisplayName, formatTime, formatLatency } from "./types";
import { Skeleton } from "@/components/ui/skeleton";

export function SidebarLeft({
  documents,
  documentsLoading,
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
    <aside className="hidden w-[280px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-zinc-200 bg-white p-4 lg:flex">
      {/* New Conversation */}
      <button
        type="button"
        onClick={onNewConversation}
        className="w-full rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 transition hover:bg-indigo-100 active:scale-[0.98]"
      >
        + New Chat
      </button>

      {/* Query Timeline */}
      <section>
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium text-zinc-500">Query Timeline</h3>
          <button
            type="button"
            onClick={onRefreshHistory}
            className="rounded px-1.5 py-0.5 text-xs font-medium text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600"
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
            <p className="text-xs text-zinc-400">No history yet.</p>
          ) : (
            queryHistory.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => onRestoreHistory(item)}
                className="w-full rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 text-left transition hover:border-zinc-200 hover:bg-white"
              >
                <p className="truncate text-xs font-medium text-zinc-700">{item.query}</p>
                <p className="mt-0.5 text-xs text-zinc-400">
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
          <h3 className="text-xs font-medium text-zinc-500">Documents</h3>
          <button
            type="button"
            onClick={onRefreshDocuments}
            className="rounded px-1.5 py-0.5 text-xs font-medium text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600"
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
            <p className="text-xs text-zinc-400">No documents ingested yet.</p>
          ) : (
            <ul className="max-h-60 space-y-1.5 overflow-y-auto">
              {documents.map((doc) => {
                const displayName = getDocumentDisplayName(doc);
                const isScoped = queryDocumentScopeIds.includes(doc.id);
                const statusColor: Record<string, string> = {
                  ready: "text-emerald-600",
                  processing: "text-amber-600",
                  queued: "text-zinc-400",
                  failed: "text-rose-600",
                };

                return (
                  <li key={doc.id} className="flex items-center gap-2 rounded-lg border border-zinc-100 bg-zinc-50 px-2.5 py-1.5 text-xs">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-zinc-700" title={displayName}>
                        {displayName}
                      </p>
                      <span className={`text-xs font-medium ${statusColor[doc.status] ?? "text-zinc-400"}`}>
                        {doc.status}
                      </span>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => toggleQueryDocumentScopeId(doc.id)}
                        className={`rounded px-1.5 py-0.5 text-xs font-medium transition ${
                          isScoped
                            ? "bg-indigo-100 text-indigo-700 hover:bg-indigo-200"
                            : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                        }`}
                        title={isScoped ? "Remove from scope" : "Add this document to scope"}
                      >
                        {isScoped ? "Scoped" : "Scope"}
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteDocument(doc.id)}
                        className="rounded p-1 text-rose-500 transition hover:bg-rose-50"
                        title="Delete document"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
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
