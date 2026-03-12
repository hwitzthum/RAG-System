import type { SidebarLeftProps } from "./types";
import { getDocumentDisplayName, formatTime } from "./types";
import { Skeleton } from "@/components/ui/skeleton";

export function SidebarLeft({
  documents,
  documentsLoading,
  queryDocumentScopeId,
  setQueryDocumentScopeId,
  onDeleteDocument,
  onRefreshDocuments,
  queryHistory,
  historyLoading,
  onRefreshHistory,
  onRestoreHistory,
}: SidebarLeftProps) {
  return (
    <aside className="flex w-[280px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-zinc-200 bg-white p-4">
      {/* Query Timeline */}
      <section>
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium text-zinc-500">Query Timeline</h3>
          <button
            type="button"
            onClick={onRefreshHistory}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600"
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
                <p className="mt-0.5 text-[10px] text-zinc-400">
                  {formatTime(item.createdAt)} | {item.latencyMs}ms
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
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600"
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
                const isScoped = queryDocumentScopeId === doc.id;
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
                      <span className={`text-[10px] font-medium ${statusColor[doc.status] ?? "text-zinc-400"}`}>
                        {doc.status}
                      </span>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => setQueryDocumentScopeId(isScoped ? null : doc.id)}
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition ${
                          isScoped
                            ? "bg-teal-100 text-teal-700 hover:bg-teal-200"
                            : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                        }`}
                        title={isScoped ? "Remove scope" : "Scope queries to this document"}
                      >
                        {isScoped ? "Scoped" : "Scope"}
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteDocument(doc.id)}
                        className="rounded px-1.5 py-0.5 text-[10px] font-medium text-rose-500 transition hover:bg-rose-50"
                        title="Delete document"
                      >
                        Del
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
