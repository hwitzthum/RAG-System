import type { ChatInputProps } from "./types";

export function ChatInput({
  query,
  setQuery,
  executeQuery,
  isStreaming,
  enableWebResearch,
  setEnableWebResearch,
  canQuery,
  effectiveQueryScopeId,
  onClearScope,
}: ChatInputProps) {
  return (
    <div className="border-t border-zinc-200 bg-white p-4">
      <div className="flex gap-2">
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              executeQuery();
            }
          }}
          placeholder="Ask about indexed documents..."
          rows={2}
          className="flex-1 resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-800 placeholder:text-zinc-400 transition focus:border-teal-400"
        />
        <button
          type="button"
          disabled={!canQuery || isStreaming || query.trim().length === 0}
          onClick={executeQuery}
          className="self-end rounded-lg bg-teal-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-zinc-300 active:scale-[0.98]"
        >
          {isStreaming ? "Streaming..." : "Send"}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-zinc-500">
          <input
            type="checkbox"
            checked={enableWebResearch}
            onChange={(e) => setEnableWebResearch(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-zinc-300 text-teal-600"
            data-testid="web-research-toggle"
          />
          Web Research
        </label>
        {effectiveQueryScopeId ? (
          <button
            type="button"
            onClick={onClearScope}
            className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 text-[11px] font-medium text-zinc-500 transition hover:bg-zinc-100"
          >
            Scope: {effectiveQueryScopeId.slice(0, 8)}... (clear)
          </button>
        ) : null}
        {!canQuery ? (
          <span className="text-[11px] text-zinc-400">
            Requires reader/admin role
          </span>
        ) : null}
      </div>
    </div>
  );
}
