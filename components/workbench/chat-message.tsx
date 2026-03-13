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
      <span className="h-1.5 w-1.5 rounded-full bg-teal-500 animate-bounce [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 rounded-full bg-teal-500 animate-bounce [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 rounded-full bg-teal-500 animate-bounce [animation-delay:300ms]" />
    </span>
  );
}

export function ChatMessage({ turn, isActive, onClick, downloadReport }: ChatMessageProps) {
  return (
    <article
      className={`cursor-pointer rounded-xl border p-4 transition ${
        isActive
          ? "border-teal-300 bg-teal-50/60 shadow-sm"
          : "border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-sm"
      }`}
      onClick={onClick}
      data-testid="chat-turn"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-zinc-400">{formatTime(turn.createdAt)}</p>
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] font-medium text-zinc-500">
            {turn.citations.length} citations
          </span>
          {turn.retrievalMeta ? (
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                turn.retrievalMeta.cacheHit
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-amber-200 bg-amber-50 text-amber-700"
              }`}
            >
              cache {turn.retrievalMeta.cacheHit ? "hit" : "miss"}
            </span>
          ) : null}
          {turn.pending ? <StreamingDots /> : null}
          {turn.failed ? (
            <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700">
              failed
            </span>
          ) : null}
        </div>
      </div>
      <p className="mt-3 text-sm font-medium text-zinc-900">{turn.query}</p>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-600">
        {turn.answer || (turn.pending ? "" : "...")}
      </p>
      {turn.webSources && turn.webSources.length > 0 ? (
        <div className="mt-3 space-y-1">
          <p className="text-[11px] font-medium text-blue-700">Web Sources</p>
          {turn.webSources.map((source) => (
            <a
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="block rounded-lg border border-blue-100 bg-blue-50/50 px-2.5 py-1.5 text-xs text-blue-800 hover:bg-blue-100"
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
            className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50 active:scale-[0.98]"
          >
            DOCX
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); downloadReport(turn.queryHistoryId!, "pdf"); }}
            className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50 active:scale-[0.98]"
          >
            PDF
          </button>
        </div>
      ) : null}
    </article>
  );
}
