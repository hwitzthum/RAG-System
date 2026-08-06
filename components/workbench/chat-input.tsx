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
    <div className="nav-surface border-t p-5">
      <div className="flex gap-2">
        <textarea
          ref={textareaRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            handleInput();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              executeQuery();
            }
          }}
          placeholder="Ask about indexed documents..."
          rows={1}
          className="input-surface flex-1 resize-none px-4 py-3 text-sm"
          data-testid="chat-query-input"
        />
        <button
          type="button"
          disabled={!canQuery || isStreaming || query.trim().length === 0}
          onClick={executeQuery}
          className="btn-primary self-end px-6 py-3 text-[11px] disabled:cursor-not-allowed"
          data-testid="chat-send-button"
        >
          {isStreaming ? "Streaming..." : "Send"}
        </button>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <label className="label-caps flex items-center gap-2">
          <input
            type="checkbox"
            checked={enableWebResearch}
            onChange={(e) => setEnableWebResearch(e.target.checked)}
            className="check-accent h-3.5 w-3.5"
            data-testid="web-research-toggle"
          />
          Web Research
        </label>
        <label className="label-caps flex items-center gap-2">
          <input
            type="checkbox"
            checked={enableQueryExpansion}
            onChange={(e) => setEnableQueryExpansion(e.target.checked)}
            className="check-accent h-3.5 w-3.5"
            data-testid="query-expansion-toggle"
          />
          Broaden search
          <span className="fg-muted">(query variations + HyDE)</span>
        </label>
        {effectiveQueryScopeIds.length > 0 ? (
          <button
            type="button"
            onClick={onClearScope}
            className="badge badge-accent max-w-full"
            title="Clear document scope"
          >
            <span className="shrink-0">Scope</span>
            {/* Filenames keep their own casing — the badge's tracked caps are
                for labels, not user content. */}
            <span className="min-w-0 truncate normal-case tracking-normal">
              {scopeSummary ?? `${effectiveQueryScopeIds.length} documents`}
            </span>
            <span className="fg-muted shrink-0">Clear</span>
          </button>
        ) : null}
        {!canQuery ? (
          <span className="fg-muted text-xs">Requires reader/admin role</span>
        ) : null}
      </div>
    </div>
  );
}
