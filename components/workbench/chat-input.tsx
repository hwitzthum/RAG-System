"use client";

import { useRef, useCallback } from "react";
import type { ChatInputProps } from "./types";

export function ChatInput({
  query,
  setQuery,
  executeQuery,
  isStreaming,
  enableWebResearch,
  setEnableWebResearch,
  enableQueryExpansion,
  setEnableQueryExpansion,
  canQuery,
  effectiveQueryScopeIds,
  scopeSummary,
  onClearScope,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  return (
    <div className="nav-surface border-t p-4">
      <div className="flex gap-2">
        <textarea
          ref={textareaRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); handleInput(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              executeQuery();
            }
          }}
          placeholder="Ask about indexed documents..."
          rows={1}
          className="input-surface flex-1 resize-none rounded-2xl px-3 py-2.5 text-sm"
          data-testid="chat-query-input"
        />
        <button
          type="button"
          disabled={!canQuery || isStreaming || query.trim().length === 0}
          onClick={executeQuery}
          className="btn-primary self-end rounded-2xl px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed active:scale-[0.98]"
          data-testid="chat-send-button"
        >
          {isStreaming ? "Streaming..." : "Send"}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="fg-secondary flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={enableWebResearch}
            onChange={(e) => setEnableWebResearch(e.target.checked)}
            className="check-accent h-3.5 w-3.5 rounded"
            data-testid="web-research-toggle"
          />
          Web Research
        </label>
        <label className="fg-secondary flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={enableQueryExpansion}
            onChange={(e) => setEnableQueryExpansion(e.target.checked)}
            disabled={effectiveQueryScopeIds.length <= 1}
            className="check-accent h-3.5 w-3.5 rounded disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="query-expansion-toggle"
          />
          Broaden search
          <span className="fg-muted">
            {effectiveQueryScopeIds.length > 1 ? "(multi-document)" : "(select 2+ scoped docs)"}
          </span>
        </label>
        {effectiveQueryScopeIds.length > 0 ? (
          <button
            type="button"
            onClick={onClearScope}
            className="badge badge-accent"
          >
            Scope: {scopeSummary ?? `${effectiveQueryScopeIds.length} documents`} (clear)
          </button>
        ) : null}
        {!canQuery ? (
          <span className="fg-muted text-xs">
            Requires reader/admin role
          </span>
        ) : null}
      </div>
    </div>
  );
}
