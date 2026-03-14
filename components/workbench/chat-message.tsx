"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";
import type { Turn } from "./types";
import { formatTime } from "./types";

type ChatMessageProps = {
  turn: Turn;
  isActive: boolean;
  onClick: () => void;
  downloadReport: (queryHistoryId: string, format: "docx" | "pdf") => void;
};

function StreamingDots() {
  return (
    <span className="inline-flex gap-1">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)] animate-bounce [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)] animate-bounce [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)] animate-bounce [animation-delay:300ms]" />
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="btn-secondary rounded-lg px-2 py-1 text-xs font-medium active:scale-[0.98]"
      title="Copy answer"
    >
      {copied ? <Check className="tone-success h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

export function ChatMessage({ turn, isActive, onClick, downloadReport }: ChatMessageProps) {
  return (
    <article
      className={`cursor-pointer rounded-2xl border p-4 transition ${
        isActive
          ? "surface-accent shadow-sm"
          : "surface-card hover:border-[var(--accent-border)] hover:shadow-sm"
      }`}
      onClick={onClick}
      data-testid="chat-turn"
    >
      {/* Query */}
      <div className="flex items-center gap-2">
        <span className="badge badge-muted">You</span>
        <p className="fg-muted text-xs">{formatTime(turn.createdAt)}</p>
      </div>
      <p className="fg-primary mt-2 text-sm font-medium">{turn.query}</p>

      {/* Separator */}
      <div className="mt-3 border-t border-[var(--border)] pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="badge badge-accent">AI</span>
          <div className="flex flex-wrap gap-1.5">
            <span className="badge badge-muted">
              {turn.citations.length} citations
            </span>
            {turn.retrievalMeta ? (
              <span
                className={`badge ${
                  turn.retrievalMeta.cacheHit ? "badge-success" : "badge-warning"
                }`}
              >
                cache {turn.retrievalMeta.cacheHit ? "hit" : "miss"}
              </span>
            ) : null}
            {turn.pending ? <StreamingDots /> : null}
            {turn.failed ? (
              <span className="badge badge-danger">
                failed
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Answer with Markdown */}
      {turn.answer ? (
        <div className="prose prose-sm prose-themed mt-2 max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {turn.answer}
          </ReactMarkdown>
        </div>
      ) : turn.pending ? null : (
        <p className="fg-muted mt-2 text-sm">...</p>
      )}

      {turn.webSources && turn.webSources.length > 0 ? (
        <div className="mt-3 space-y-1">
          <p className="tone-info text-xs font-medium">Web Sources</p>
          {turn.webSources.map((source) => (
            <a
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="badge-info block rounded-lg border px-2.5 py-1.5 text-xs transition hover:opacity-90"
            >
              {source.title}
            </a>
          ))}
        </div>
      ) : null}
      {!turn.pending && !turn.failed && turn.queryHistoryId ? (
        <div className="mt-3 flex gap-2" data-testid="report-downloads">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); downloadReport(turn.queryHistoryId!, "docx"); }}
            className="btn-secondary rounded-lg px-2.5 py-1 text-xs font-medium active:scale-[0.98]"
          >
            DOCX
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); downloadReport(turn.queryHistoryId!, "pdf"); }}
            className="btn-secondary rounded-lg px-2.5 py-1 text-xs font-medium active:scale-[0.98]"
          >
            PDF
          </button>
          <CopyButton text={turn.answer} />
        </div>
      ) : null}
    </article>
  );
}
