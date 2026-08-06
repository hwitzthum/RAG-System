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
    <span className="inline-flex items-center gap-1" aria-label="Streaming">
      <span className="h-1 w-1 bg-[var(--accent)] animate-bounce [animation-delay:0ms]" />
      <span className="h-1 w-1 bg-[var(--accent)] animate-bounce [animation-delay:150ms]" />
      <span className="h-1 w-1 bg-[var(--accent)] animate-bounce [animation-delay:300ms]" />
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
      className="btn-secondary px-3 py-1.5 text-[10px]"
      title="Copy answer"
    >
      {copied ? (
        <Check className="tone-success h-3.5 w-3.5" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

export function ChatMessage({
  turn,
  isActive,
  onClick,
  downloadReport,
}: ChatMessageProps) {
  return (
    <article
      className={`cursor-pointer p-6 transition ${
        isActive
          ? "surface-accent"
          : "surface-card hover:bg-[var(--emphasis-soft)]"
      }`}
      onClick={onClick}
      data-testid="chat-turn"
    >
      {/* Query */}
      <div className="flex items-center gap-3">
        <span className="badge badge-muted">You</span>
        <p className="label-caps">{formatTime(turn.createdAt)}</p>
      </div>
      <p className="display-console mt-3">{turn.query}</p>

      {/* Separator */}
      <div className="mt-5 border-t border-[var(--border)] pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="badge badge-accent">AI</span>
          <div className="flex flex-wrap gap-1.5">
            <span className="badge badge-muted">
              {turn.citations.length} citations
            </span>
            {turn.retrievalMeta ? (
              <span
                className={`badge ${
                  turn.retrievalMeta.cacheHit
                    ? "badge-success"
                    : "badge-warning"
                }`}
              >
                cache {turn.retrievalMeta.cacheHit ? "hit" : "miss"}
              </span>
            ) : null}
            {turn.retrievalMeta?.citationVerification &&
            !turn.retrievalMeta.citationVerification.unverified &&
            turn.retrievalMeta.citationVerification.unsupportedCount > 0 ? (
              <span
                className="badge badge-warning"
                title={`${turn.retrievalMeta.citationVerification.unsupportedCount} of ${turn.retrievalMeta.citationVerification.checkedCount} cited statements could not be verified against their sources`}
              >
                {turn.retrievalMeta.citationVerification.unsupportedCount}{" "}
                unverified claim
                {turn.retrievalMeta.citationVerification.unsupportedCount > 1
                  ? "s"
                  : ""}
              </span>
            ) : null}
            {turn.retrievalMeta?.answerTruncated ? (
              <span
                className="badge badge-warning"
                title="The answer reached the output-length limit and stops mid-thought. Ask a narrower question, or raise RAG_LLM_MAX_OUTPUT_TOKENS."
              >
                truncated
              </span>
            ) : null}
            {turn.pending ? <StreamingDots /> : null}
            {turn.failed ? (
              <span className="badge badge-danger">failed</span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Answer with Markdown */}
      {turn.answer ? (
        <div className="prose prose-sm prose-themed mt-5 max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {turn.answer}
          </ReactMarkdown>
        </div>
      ) : turn.pending ? null : (
        <p className="fg-muted mt-2 text-sm">...</p>
      )}

      {turn.webSources && turn.webSources.length > 0 ? (
        <div className="mt-6 space-y-1.5">
          <p className="section-label section-label-sub mb-3">Web Sources</p>
          {turn.webSources
            .filter((source) => /^https?:\/\//i.test(source.url))
            .map((source) => (
              <a
                key={source.url}
                href={source.url}
                target="_blank"
                rel="noreferrer noopener"
                className="badge-info block border px-3 py-2 text-xs transition hover:opacity-80"
              >
                {source.title}
              </a>
            ))}
        </div>
      ) : null}
      {!turn.pending && !turn.failed && turn.queryHistoryId ? (
        <div className="mt-6 flex gap-2" data-testid="report-downloads">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              downloadReport(turn.queryHistoryId!, "docx");
            }}
            className="btn-secondary px-3 py-1.5 text-[10px]"
          >
            DOCX
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              downloadReport(turn.queryHistoryId!, "pdf");
            }}
            className="btn-secondary px-3 py-1.5 text-[10px]"
          >
            PDF
          </button>
          <CopyButton text={turn.answer} />
        </div>
      ) : null}
    </article>
  );
}
