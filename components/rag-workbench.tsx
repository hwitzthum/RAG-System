"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuthUser } from "@/lib/auth/types";
import type {
  OpenAiByokStatusResponse,
  QueryHistoryItem,
  QueryHistoryResponse,
  QuerySseFinalEvent,
  QuerySseMetaEvent,
  QuerySseTokenEvent,
} from "@/lib/contracts/api";
import type { Citation } from "@/lib/contracts/retrieval";

type RagWorkbenchProps = {
  initialUser: AuthUser | null;
};

type Turn = {
  id: string;
  conversationId: string;
  query: string;
  answer: string;
  citations: Citation[];
  pending: boolean;
  failed: boolean;
  retrievalMeta: QuerySseMetaEvent["retrievalMeta"] | null;
  createdAt: string;
};

type UploadStatusSnapshot = {
  document: {
    id: string;
    status: string;
    ingestion_version: number;
    created_at: string;
    updated_at: string;
  };
  latestIngestionJob: {
    id: string;
    status: string;
    attempt: number;
    last_error: string | null;
    locked_at: string | null;
    locked_by: string | null;
    created_at: string;
    updated_at: string;
  } | null;
};

type ParsedSseEvent =
  | { event: "meta"; payload: QuerySseMetaEvent }
  | { event: "token"; payload: QuerySseTokenEvent }
  | { event: "final"; payload: QuerySseFinalEvent }
  | { event: "done"; payload: { queryId: string } }
  | null;

function newUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `temp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseSseEventBlock(rawBlock: string): ParsedSseEvent {
  const lines = rawBlock.split("\n");
  let eventName = "";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  if (!eventName || dataLines.length === 0) {
    return null;
  }

  try {
    const payload = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    if (eventName === "meta") {
      return { event: "meta", payload: payload as QuerySseMetaEvent };
    }
    if (eventName === "token") {
      return { event: "token", payload: payload as QuerySseTokenEvent };
    }
    if (eventName === "final") {
      return { event: "final", payload: payload as QuerySseFinalEvent };
    }
    if (eventName === "done") {
      return { event: "done", payload: payload as { queryId: string } };
    }
    return null;
  } catch {
    return null;
  }
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString();
}

export function RagWorkbench({ initialUser }: RagWorkbenchProps) {
  const [user, setUser] = useState<AuthUser | null>(initialUser);
  const [token, setToken] = useState("");
  const [openAiByokInput, setOpenAiByokInput] = useState("");
  const [openAiByokStatus, setOpenAiByokStatus] = useState<OpenAiByokStatusResponse | null>(null);
  const [openAiByokLoading, setOpenAiByokLoading] = useState(false);
  const [conversationId, setConversationId] = useState(newUuid);
  const [query, setQuery] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [queryHistory, setQueryHistory] = useState<QueryHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [workspaceMessage, setWorkspaceMessage] = useState("Ready.");

  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadLanguageHint, setUploadLanguageHint] = useState("");
  const [uploadStatus, setUploadStatus] = useState<UploadStatusSnapshot | null>(null);

  const canQuery = user?.role === "reader" || user?.role === "admin";
  const canUpload = user?.role === "reader" || user?.role === "admin";

  const activeTurn = useMemo(() => {
    if (activeTurnId) {
      const explicit = turns.find((turn) => turn.id === activeTurnId);
      if (explicit) {
        return explicit;
      }
    }
    return turns[turns.length - 1] ?? null;
  }, [activeTurnId, turns]);

  const loadHistory = useCallback(async (): Promise<void> => {
    if (!user) {
      setQueryHistory([]);
      return;
    }

    setHistoryLoading(true);
    try {
      const response = await fetch(`/api/query-history?limit=25`, {
        method: "GET",
      });
      if (!response.ok) {
        setWorkspaceMessage("Failed to load query history.");
        return;
      }

      const payload = (await response.json()) as QueryHistoryResponse;
      setQueryHistory(payload.items ?? []);
    } finally {
      setHistoryLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const loadOpenAiByokStatus = useCallback(async (): Promise<void> => {
    if (!user) {
      setOpenAiByokStatus(null);
      return;
    }

    setOpenAiByokLoading(true);
    try {
      const response = await fetch("/api/byok/openai", { method: "GET" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setWorkspaceMessage(payload.error ?? "Unable to load OpenAI BYOK status.");
        return;
      }

      const payload = (await response.json()) as OpenAiByokStatusResponse;
      setOpenAiByokStatus(payload);
    } finally {
      setOpenAiByokLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadOpenAiByokStatus();
  }, [loadOpenAiByokStatus]);

  function patchTurn(turnId: string, updater: (turn: Turn) => Turn): void {
    setTurns((current) => current.map((turn) => (turn.id === turnId ? updater(turn) : turn)));
  }

  async function createSession(): Promise<void> {
    const response = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: token }),
    });

    const payload = (await response.json()) as { user?: AuthUser; error?: string };
    if (!response.ok || !payload.user) {
      setWorkspaceMessage(payload.error ?? "Session creation failed.");
      return;
    }

    setUser(payload.user);
    setWorkspaceMessage(`Session created for role=${payload.user.role}.`);
  }

  async function clearSession(): Promise<void> {
    const response = await fetch("/api/auth/session", { method: "DELETE" });
    if (response.ok) {
      setUser(null);
      setOpenAiByokInput("");
      setOpenAiByokStatus(null);
      setTurns([]);
      setQueryHistory([]);
      setWorkspaceMessage("Session cleared.");
    }
  }

  async function saveOpenAiByokKey(): Promise<void> {
    if (!user) {
      setWorkspaceMessage("Create a session before configuring OpenAI BYOK.");
      return;
    }

    if (!openAiByokInput.trim()) {
      setWorkspaceMessage("Enter an OpenAI API key first.");
      return;
    }

    setOpenAiByokLoading(true);
    try {
      const response = await fetch("/api/byok/openai", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: openAiByokInput,
        }),
      });
      const payload = (await response.json()) as OpenAiByokStatusResponse & { error?: string };

      if (!response.ok) {
        setWorkspaceMessage(payload.error ?? "Failed to save OpenAI API key.");
        return;
      }

      setOpenAiByokStatus(payload);
      setOpenAiByokInput("");
      setWorkspaceMessage("OpenAI BYOK key stored in encrypted vault.");
    } finally {
      setOpenAiByokLoading(false);
    }
  }

  async function deleteOpenAiByokKey(): Promise<void> {
    if (!user) {
      return;
    }

    setOpenAiByokLoading(true);
    try {
      const response = await fetch("/api/byok/openai", {
        method: "DELETE",
      });
      const payload = (await response.json()) as OpenAiByokStatusResponse & { error?: string };

      if (!response.ok) {
        setWorkspaceMessage(payload.error ?? "Failed to remove OpenAI API key.");
        return;
      }

      setOpenAiByokStatus(payload);
      setWorkspaceMessage("OpenAI BYOK key removed from vault.");
    } finally {
      setOpenAiByokLoading(false);
    }
  }

  async function refreshUploadStatus(documentId: string): Promise<void> {
    const response = await fetch(`/api/upload/${documentId}`, {
      method: "GET",
    });
    if (!response.ok) {
      setWorkspaceMessage("Unable to fetch upload status.");
      return;
    }

    const payload = (await response.json()) as UploadStatusSnapshot;
    setUploadStatus(payload);
  }

  async function uploadPdf(): Promise<void> {
    if (!uploadFile) {
      setWorkspaceMessage("Select a PDF file first.");
      return;
    }

    const formData = new FormData();
    formData.append("file", uploadFile);
    if (uploadTitle.trim()) {
      formData.append("title", uploadTitle.trim());
    }
    if (uploadLanguageHint) {
      formData.append("language_hint", uploadLanguageHint);
    }

    const response = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    const payload = (await response.json()) as { documentId?: string; error?: string };
    if (!response.ok || !payload.documentId) {
      setWorkspaceMessage(payload.error ?? "Upload failed.");
      return;
    }

    setWorkspaceMessage(`Upload accepted. documentId=${payload.documentId}`);
    await refreshUploadStatus(payload.documentId);
  }

  async function executeQuery(): Promise<void> {
    if (!canQuery || !query.trim() || isStreaming) {
      return;
    }

    const question = query.trim();
    setQuery("");
    setWorkspaceMessage("Query in progress...");
    setIsStreaming(true);

    const turnId = newUuid();
    const startedAt = new Date().toISOString();
    const pendingTurn: Turn = {
      id: turnId,
      conversationId,
      query: question,
      answer: "",
      citations: [],
      pending: true,
      failed: false,
      retrievalMeta: null,
      createdAt: startedAt,
    };
    setTurns((current) => [...current, pendingTurn]);
    setActiveTurnId(turnId);

    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: question,
          conversationId,
        }),
      });

      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Query failed");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        let boundaryIndex = buffer.indexOf("\n\n");

        while (boundaryIndex !== -1) {
          const rawBlock = buffer.slice(0, boundaryIndex).trim();
          buffer = buffer.slice(boundaryIndex + 2);
          boundaryIndex = buffer.indexOf("\n\n");

          if (!rawBlock) {
            continue;
          }

          const parsed = parseSseEventBlock(rawBlock);
          if (!parsed) {
            continue;
          }

          if (parsed.event === "meta") {
            patchTurn(turnId, (turn) => ({
              ...turn,
              retrievalMeta: parsed.payload.retrievalMeta,
              conversationId: parsed.payload.retrievalMeta.conversationId ?? turn.conversationId,
            }));
            setConversationId(parsed.payload.retrievalMeta.conversationId ?? conversationId);
          } else if (parsed.event === "token") {
            patchTurn(turnId, (turn) => ({
              ...turn,
              answer: `${turn.answer}${parsed.payload.token}`,
            }));
          } else if (parsed.event === "final") {
            patchTurn(turnId, (turn) => ({
              ...turn,
              answer: parsed.payload.answer,
              citations: parsed.payload.citations,
              retrievalMeta: parsed.payload.retrievalMeta,
              pending: false,
            }));
          } else if (parsed.event === "done") {
            patchTurn(turnId, (turn) => ({
              ...turn,
              pending: false,
            }));
          }
        }
      }

      patchTurn(turnId, (turn) => ({ ...turn, pending: false }));
      setWorkspaceMessage("Query complete.");
      await loadHistory();
    } catch (error) {
      patchTurn(turnId, (turn) => ({
        ...turn,
        pending: false,
        failed: true,
        answer: "Query failed. Please retry.",
      }));
      setWorkspaceMessage(error instanceof Error ? error.message : "Query failed.");
    } finally {
      setIsStreaming(false);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <section className="space-y-5 rounded-2xl border border-cyan-100 bg-white/85 p-5 shadow-[0_12px_30px_-20px_rgba(8,47,73,0.6)] backdrop-blur">
        <header className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-700">Phase 10 Workspace</p>
          <h2 className="text-2xl font-semibold text-slate-900">Streaming Chat</h2>
          <p className="text-sm text-slate-600">SSE token stream with citation-linked grounded responses.</p>
        </header>

        <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50/80 p-4">
          <p className="text-sm font-medium text-slate-800">
            {user ? `Signed in as ${user.role} (${user.email ?? user.id})` : "No active session"}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Paste access token"
              className="min-w-[240px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={createSession}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white"
            >
              Create Session
            </button>
            <button
              type="button"
              onClick={clearSession}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="grid gap-3 rounded-xl border border-rose-200 bg-rose-50/70 p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-rose-900">OpenAI BYOK Vault</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void loadOpenAiByokStatus()}
                disabled={!user || openAiByokLoading}
                className="rounded-lg border border-rose-300 bg-white px-2 py-1 text-xs font-semibold text-rose-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Refresh Status
              </button>
              <button
                type="button"
                onClick={deleteOpenAiByokKey}
                disabled={!openAiByokStatus?.configured || openAiByokLoading}
                className="rounded-lg border border-rose-300 bg-white px-2 py-1 text-xs font-semibold text-rose-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Delete Key
              </button>
            </div>
          </div>
          <p className="text-xs text-rose-800">
            Your OpenAI key is encrypted server-side and never exposed in request headers or stored in browser
            persistence.
          </p>
          <input
            value={openAiByokInput}
            onChange={(event) => setOpenAiByokInput(event.target.value)}
            type="password"
            placeholder="Enter OpenAI API key (sk-...)"
            disabled={!user}
            className="w-full rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={saveOpenAiByokKey}
              disabled={openAiByokLoading || !user}
              className="rounded-lg bg-rose-700 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {openAiByokLoading ? "Saving..." : "Save OpenAI Key"}
            </button>
            <button
              type="button"
              onClick={() => setOpenAiByokInput("")}
              disabled={!user}
              className="rounded-lg border border-rose-300 bg-white px-3 py-2 text-xs font-semibold text-rose-800"
            >
              Clear Input
            </button>
          </div>
          <p className="text-xs text-rose-700">
            Vault status:{" "}
            {openAiByokStatus?.vaultEnabled
              ? openAiByokStatus.configured
                ? `configured (****${openAiByokStatus.keyLast4 ?? "????"})`
                : "enabled, no user key configured"
              : "disabled"}
            {openAiByokStatus?.updatedAt ? ` | updated ${formatTime(openAiByokStatus.updatedAt)}` : ""}
          </p>
        </div>

        <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50/80 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-800">Conversation {conversationId}</p>
            <button
              type="button"
              className="rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-xs font-semibold text-cyan-800"
              onClick={() => {
                setConversationId(newUuid());
                setTurns([]);
                setActiveTurnId(null);
              }}
            >
              New Conversation
            </button>
          </div>
          <textarea
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ask about documents..."
            rows={3}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!canQuery || isStreaming || query.trim().length === 0}
              onClick={executeQuery}
              className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {isStreaming ? "Streaming..." : "Send Query"}
            </button>
            {!canQuery ? <span className="text-xs text-slate-500">Requires reader/admin role.</span> : null}
          </div>
        </div>

        <div className="space-y-3">
          {turns.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white/70 px-4 py-6 text-sm text-slate-500">
              No conversation turns yet.
            </p>
          ) : (
            turns.map((turn) => (
              <article
                key={turn.id}
                className="rounded-xl border border-slate-200 bg-white p-4"
                onClick={() => setActiveTurnId(turn.id)}
              >
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{formatTime(turn.createdAt)}</p>
                <p className="text-sm font-medium text-slate-900">{turn.query}</p>
                <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{turn.answer || "..."}</p>
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
                  <span>citations: {turn.citations.length}</span>
                  {turn.retrievalMeta ? <span>cache: {turn.retrievalMeta.cacheHit ? "hit" : "miss"}</span> : null}
                  {turn.pending ? <span>status: streaming</span> : null}
                  {turn.failed ? <span>status: failed</span> : null}
                </div>
              </article>
            ))
          )}
        </div>
      </section>

      <aside className="space-y-5">
        <section className="rounded-2xl border border-amber-100 bg-amber-50/70 p-4">
          <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-amber-900">Citations</h3>
          <p className="mt-1 text-xs text-amber-800">Source-linked citations for the selected answer.</p>
          <div className="mt-3 space-y-2">
            {activeTurn?.citations.length ? (
              activeTurn.citations.map((citation) => (
                <a
                  key={`${citation.documentId}:${citation.pageNumber}:${citation.chunkId}`}
                  className="block rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-amber-50"
                  href={`/api/upload/${citation.documentId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="font-semibold">doc:</span> {citation.documentId}
                  <br />
                  <span className="font-semibold">page:</span> {citation.pageNumber}
                  <br />
                  <span className="font-semibold">chunk:</span> {citation.chunkId}
                </a>
              ))
            ) : (
              <p className="text-xs text-slate-500">No citations to display.</p>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-emerald-100 bg-emerald-50/80 p-4">
          <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-emerald-900">Document Upload</h3>
          <div className="mt-3 space-y-2">
            <input
              type="file"
              accept=".pdf,application/pdf"
              disabled={!canUpload}
              className="block w-full text-xs disabled:cursor-not-allowed disabled:opacity-60"
              onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
            />
            <input
              value={uploadTitle}
              disabled={!canUpload}
              onChange={(event) => setUploadTitle(event.target.value)}
              placeholder="Optional title"
              className="w-full rounded-lg border border-emerald-200 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
            />
            <select
              value={uploadLanguageHint}
              disabled={!canUpload}
              onChange={(event) => setUploadLanguageHint(event.target.value)}
              className="w-full rounded-lg border border-emerald-200 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">Language hint (optional)</option>
              <option value="EN">EN</option>
              <option value="DE">DE</option>
              <option value="FR">FR</option>
              <option value="IT">IT</option>
              <option value="ES">ES</option>
            </select>
            <button
              type="button"
              onClick={uploadPdf}
              disabled={!canUpload || !uploadFile}
              className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              Upload PDF
            </button>
            {!canUpload ? (
              <p className="text-xs text-emerald-800">
                Upload requires `reader` or `admin` role. Current session role: {user?.role ?? "none"}.
              </p>
            ) : !uploadFile ? (
              <p className="text-xs text-emerald-800">Select a PDF file first to enable upload.</p>
            ) : (
              <p className="text-xs text-emerald-800">Selected file: {uploadFile.name}</p>
            )}
          </div>

          {uploadStatus ? (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-white p-3 text-xs text-slate-700">
              <p>
                <span className="font-semibold">Document:</span> {uploadStatus.document.id}
              </p>
              <p>
                <span className="font-semibold">Status:</span> {uploadStatus.document.status}
              </p>
              <p>
                <span className="font-semibold">Job:</span> {uploadStatus.latestIngestionJob?.status ?? "n/a"}
              </p>
            </div>
          ) : null}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-900">Query History</h3>
            <button
              type="button"
              onClick={() => void loadHistory()}
              className="rounded-lg border border-slate-300 bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-700"
            >
              Refresh
            </button>
          </div>
          <div className="mt-3 space-y-2">
            {historyLoading ? <p className="text-xs text-slate-500">Loading...</p> : null}
            {!historyLoading && queryHistory.length === 0 ? <p className="text-xs text-slate-500">No history yet.</p> : null}
            {queryHistory.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => {
                  setConversationId(item.conversationId ?? newUuid());
                  setQuery(item.query);
                }}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs hover:bg-slate-100"
              >
                <p className="font-semibold text-slate-800">{item.query}</p>
                <p className="mt-1 text-slate-600">
                  {formatTime(item.createdAt)} | cache: {item.cacheHit ? "hit" : "miss"} | {item.latencyMs}ms
                </p>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-900">System</h3>
          <p className="mt-2 text-xs text-slate-600">{workspaceMessage}</p>
        </section>
      </aside>
    </div>
  );
}
