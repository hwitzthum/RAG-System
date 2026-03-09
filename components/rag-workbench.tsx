"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { AuthUser } from "@/lib/auth/types";
import type {
  OpenAiByokStatusResponse,
  QueryHistoryItem,
  QueryHistoryResponse,
  QuerySseFinalEvent,
  QuerySseMetaEvent,
  QuerySseTokenEvent,
  WebSource,
} from "@/lib/contracts/api";
import type { Citation } from "@/lib/contracts/retrieval";
import type { Database } from "@/lib/supabase/database.types";

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
  queryHistoryId?: string;
  webSources?: WebSource[];
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

const QUERY_SCOPE_STORAGE_KEY = "rag.queryDocumentScopeId";

type DocumentListItem = Pick<
  Database["public"]["Tables"]["documents"]["Row"],
  "id" | "title" | "status" | "created_at" | "storage_path"
>;

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

function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|;\s*)(?:csrf_token|__Host-csrf)=([^;]*)/);
  return match?.[1] ?? "";
}

function csrfHeaders(): Record<string, string> {
  const token = getCsrfToken();
  return token ? { "X-CSRF-Token": token } : {};
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString();
}

export function RagWorkbench({ initialUser }: RagWorkbenchProps) {
  const router = useRouter();
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

  const [enableWebResearch, setEnableWebResearch] = useState(false);

  const [batchFiles, setBatchFiles] = useState<Array<{ file: File; status: string; error?: string; documentId?: string }>>([]);
  const batchFileInputRef = useRef<HTMLInputElement | null>(null);

  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadLanguageHint, setUploadLanguageHint] = useState("");
  const [uploadStatus, setUploadStatus] = useState<UploadStatusSnapshot | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadFileInputRef = useRef<HTMLInputElement | null>(null);
  const [queryDocumentScopeId, setQueryDocumentScopeId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentListItem[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);

  const canQuery = user?.role === "reader" || user?.role === "admin";
  const canUpload = Boolean(user);

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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const persistedScope = window.localStorage.getItem(QUERY_SCOPE_STORAGE_KEY);
    if (persistedScope) {
      setQueryDocumentScopeId(persistedScope);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (queryDocumentScopeId) {
      window.localStorage.setItem(QUERY_SCOPE_STORAGE_KEY, queryDocumentScopeId);
      return;
    }

    window.localStorage.removeItem(QUERY_SCOPE_STORAGE_KEY);
  }, [queryDocumentScopeId]);

  async function fetchDocuments(): Promise<void> {
    setDocumentsLoading(true);
    try {
      const res = await fetch("/api/documents");
      if (!res.ok) {
        setWorkspaceMessage("Failed to load documents.");
        return;
      }
      const json = (await res.json()) as { documents: DocumentListItem[] };
      setDocuments(json.documents);
    } finally {
      setDocumentsLoading(false);
    }
  }

  useEffect(() => {
    if (user) void fetchDocuments();
    else setDocuments([]);
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Inactivity logout: sign out after 10 minutes of no user activity
  useEffect(() => {
    if (!user) return;

    const INACTIVITY_MS = 10 * 60 * 1000; // 10 minutes
    let timer: ReturnType<typeof setTimeout>;

    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void clearSession();
      }, INACTIVITY_MS);
    };

    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "click"] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset(); // start timer immediately on login

    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

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
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
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
    await fetch("/api/auth/session", { method: "DELETE", headers: csrfHeaders() });
    // Sign out of Supabase browser session too (clears its localStorage/cookie)
    await getSupabaseBrowserClient().auth.signOut().catch(() => null);
    setUser(null);
    setOpenAiByokInput("");
    setOpenAiByokStatus(null);
    setTurns([]);
    setQueryHistory([]);
    setQueryDocumentScopeId(null);
    router.push("/login");
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
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
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
        headers: csrfHeaders(),
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

  async function refreshUploadStatus(documentId: string): Promise<UploadStatusSnapshot | null> {
    const response = await fetch(`/api/upload/${documentId}`, {
      method: "GET",
    });
    if (!response.ok) {
      setWorkspaceMessage("Unable to fetch upload status.");
      return null;
    }

    const payload = (await response.json()) as UploadStatusSnapshot;
    setUploadStatus(payload);
    return payload;
  }

  async function waitForUploadTerminalStatus(documentId: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const snapshot = await refreshUploadStatus(documentId);
      if (!snapshot) {
        return;
      }

      const documentStatus = snapshot.document.status;
      const jobStatus = snapshot.latestIngestionJob?.status ?? "unknown";
      if (documentStatus === "ready") {
        setWorkspaceMessage(`Upload indexed and ready. documentId=${documentId}`);
        return;
      }
      if (documentStatus === "failed" || jobStatus === "dead_letter") {
        setWorkspaceMessage(
          snapshot.latestIngestionJob?.last_error
            ? `Upload failed: ${snapshot.latestIngestionJob.last_error}`
            : `Upload failed. document status=${documentStatus}, job status=${jobStatus}`,
        );
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    setWorkspaceMessage("Upload queued/processing. Keep refreshing status until ready.");
  }

  async function uploadPdf(selectedFile?: File): Promise<void> {
    if (!user) {
      setWorkspaceMessage("Create a session before uploading documents.");
      return;
    }

    const fileToUpload = selectedFile ?? uploadFile;
    if (!fileToUpload) {
      setWorkspaceMessage("Select a PDF file first.");
      return;
    }

    if (
      fileToUpload.type !== "application/pdf" &&
      !fileToUpload.name.toLowerCase().endsWith(".pdf")
    ) {
      setWorkspaceMessage("Only PDF files are supported.");
      return;
    }

    setUploading(true);
    const formData = new FormData();
    formData.append("file", fileToUpload);
    if (uploadTitle.trim()) {
      formData.append("title", uploadTitle.trim());
    }
    if (uploadLanguageHint) {
      formData.append("language_hint", uploadLanguageHint);
    }

    try {
      const response = await fetch("/api/upload", {
        method: "POST",
        headers: csrfHeaders(),
        body: formData,
      });

      const payload = (await response.json()) as { documentId?: string; error?: string };
      if (!response.ok || !payload.documentId) {
        setWorkspaceMessage(payload.error ?? "Upload failed.");
        return;
      }

      setWorkspaceMessage(`Upload accepted. documentId=${payload.documentId}. Indexing started...`);
      setQueryDocumentScopeId(payload.documentId);
      setUploadFile(null);
      if (uploadFileInputRef.current) {
        uploadFileInputRef.current.value = "";
      }
      await waitForUploadTerminalStatus(payload.documentId);
      await fetchDocuments();
    } finally {
      setUploading(false);
    }
  }

  function handleUploadFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const selected = event.target.files?.[0] ?? null;
    setUploadFile(selected);

    if (!selected) {
      return;
    }

    if (!user) {
      setWorkspaceMessage("File selected. Create a session before uploading.");
      return;
    }

    void uploadPdf(selected);
  }

  function handleUploadButtonClick(): void {
    if (uploading) {
      return;
    }

    if (!uploadFile) {
      uploadFileInputRef.current?.click();
      setWorkspaceMessage("Select a PDF file first.");
      return;
    }

    void uploadPdf();
  }

  async function handleBatchUpload(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = event.target.files;
    if (!files || files.length === 0 || !user) return;

    const entries = Array.from(files).map((file) => ({ file, status: "pending" as string }));
    setBatchFiles(entries);

    for (let i = 0; i < entries.length; i++) {
      setBatchFiles((prev) => prev.map((e, j) => (j === i ? { ...e, status: "uploading" } : e)));

      const formData = new FormData();
      formData.append("file", entries[i].file);

      try {
        const response = await fetch("/api/upload/batch", { method: "POST", headers: csrfHeaders(), body: formData });
        const payload = (await response.json()) as { documentId?: string; error?: string };

        if (!response.ok || !payload.documentId) {
          setBatchFiles((prev) =>
            prev.map((e, j) => (j === i ? { ...e, status: "failed", error: payload.error ?? "Upload failed" } : e)),
          );
        } else {
          setBatchFiles((prev) =>
            prev.map((e, j) => (j === i ? { ...e, status: "queued", documentId: payload.documentId } : e)),
          );
        }
      } catch {
        setBatchFiles((prev) =>
          prev.map((e, j) => (j === i ? { ...e, status: "failed", error: "Network error" } : e)),
        );
      }
    }

    setWorkspaceMessage(`Batch upload complete: ${entries.length} files processed.`);
    await fetchDocuments();
  }

  async function handleDeleteDocumentById(docId: string): Promise<void> {
    const res = await fetch(`/api/documents/${docId}`, {
      method: "DELETE",
      headers: csrfHeaders(),
    });
    if (res.ok) {
      if (uploadStatus?.document.id === docId) setUploadStatus(null);
      if (queryDocumentScopeId === docId) {
        setQueryDocumentScopeId(null);
        localStorage.removeItem(QUERY_SCOPE_STORAGE_KEY);
      }
      await fetchDocuments();
      setWorkspaceMessage("Document deleted.");
    } else {
      setWorkspaceMessage("Failed to delete document.");
    }
  }


  async function downloadReport(queryHistoryId: string, format: "docx" | "pdf"): Promise<void> {
    setWorkspaceMessage(`Generating ${format.toUpperCase()} report...`);
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ queryHistoryId, format }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setWorkspaceMessage(payload.error ?? "Report generation failed.");
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `report-${queryHistoryId.slice(0, 8)}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
      setWorkspaceMessage(`${format.toUpperCase()} report downloaded.`);
    } catch {
      setWorkspaceMessage("Report download failed.");
    }
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
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({
          query: question,
          conversationId,
          documentId: (queryDocumentScopeId ?? uploadStatus?.document.id) ?? undefined,
          enableWebResearch: enableWebResearch || undefined,
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
              queryHistoryId: parsed.payload.queryHistoryId,
              webSources: parsed.payload.webSources,
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

  const vaultStatusText = openAiByokStatus?.vaultEnabled
    ? openAiByokStatus.configured
      ? `Configured (****${openAiByokStatus.keyLast4 ?? "????"})`
      : "Vault enabled, no user key"
    : "Vault disabled";

  const workspaceToneClass = workspaceMessage.toLowerCase().includes("failed")
    ? "text-rose-900"
    : workspaceMessage.toLowerCase().includes("ready") || workspaceMessage.toLowerCase().includes("complete")
      ? "text-teal-900"
      : "text-slate-700";
  const totalCitations = turns.reduce((total, turn) => total + turn.citations.length, 0);
  const conversationPreview = `${conversationId.slice(0, 8)}...`;
  const operatorRole = user?.role.toUpperCase() ?? "GUEST";
  const queryStateLabel = canQuery ? "Query access enabled" : "Query access locked";
  const effectiveQueryScopeId = queryDocumentScopeId ?? uploadStatus?.document.id ?? null;
  const queryScopeLabel = effectiveQueryScopeId
    ? `Document scope: ${effectiveQueryScopeId.slice(0, 8)}...`
    : "Document scope: all ready documents";

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
      <section className="relative overflow-hidden rounded-[28px] border border-[#d9c9b4] bg-[linear-gradient(160deg,rgba(255,253,250,0.96),rgba(255,248,238,0.88))] p-5 shadow-[0_32px_80px_-44px_rgba(15,23,42,0.72)] backdrop-blur md:p-7">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-[linear-gradient(90deg,rgba(13,148,136,0.22),rgba(180,83,9,0.16),transparent)]" />
        <header className="relative space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-teal-900/85">Response Workspace</p>
          <h2 className="font-display text-3xl leading-tight text-slate-900 md:text-4xl">Grounded Answer Operations</h2>
          <p className="max-w-3xl text-sm leading-relaxed text-slate-700">
            Secure credentials, evidence-linked generation, and retrieval activity in a single production console.
          </p>
        </header>

        <div className="relative mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <article className="rounded-2xl border border-[#d8c8b4] bg-white/75 px-3.5 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Role</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">{operatorRole}</p>
          </article>
          <article className="rounded-2xl border border-[#d8c8b4] bg-white/75 px-3.5 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Conversation</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">{conversationPreview}</p>
          </article>
          <article className="rounded-2xl border border-[#d8c8b4] bg-white/75 px-3.5 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Turns</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">{turns.length}</p>
          </article>
          <article className="rounded-2xl border border-[#d8c8b4] bg-white/75 px-3.5 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Citations</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">{totalCitations}</p>
          </article>
        </div>

        <div className="relative mt-6 grid gap-4 rounded-2xl border border-[#d8c8b4] bg-white/70 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="space-y-1.5">
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Session Identity</p>
            <p className="text-sm font-medium text-slate-800">
              {user ? `Signed in as ${user.role} (${user.email ?? user.id})` : "No active session"}
            </p>
          </div>
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            <span className="rounded-full border border-teal-300 bg-teal-50 px-3 py-1 text-teal-900">Auth</span>
            <span className="rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-amber-900">Vault</span>
            {user?.role === "admin" && (
              <a
                href="/admin"
                className="rounded-full border border-purple-300 bg-purple-50 px-3 py-1 text-purple-900 transition hover:bg-purple-100"
                data-testid="admin-link"
              >
                Admin
              </a>
            )}
            {user && (
              <button
                type="button"
                onClick={() => void clearSession()}
                className="rounded-full border border-slate-300 bg-slate-50 px-3 py-1 text-slate-700 transition hover:bg-slate-100"
                data-testid="sign-out-button"
              >
                Sign Out
              </button>
            )}
          </div>
          <div className="md:col-span-2">
            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Paste Supabase access token"
                className="w-full rounded-xl border border-[#cdbca8] bg-white/95 px-3.5 py-2.5 text-sm text-slate-800 placeholder:text-slate-400"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={createSession}
                  className="rounded-xl border border-slate-900 bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700"
                >
                  Create Session
                </button>
                <button
                  type="button"
                  onClick={clearSession}
                  className="rounded-xl border border-[#d0c0ac] bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-[#f6efe5]"
                >
                  Clear
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-3 rounded-2xl border border-[#e4c5bc] bg-[linear-gradient(140deg,rgba(255,241,239,0.84),rgba(255,251,248,0.92))] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold uppercase tracking-[0.14em] text-rose-950">OpenAI BYOK Vault</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void loadOpenAiByokStatus()}
                disabled={!user || openAiByokLoading}
                className="rounded-lg border border-rose-300 bg-white/90 px-2.5 py-1.5 text-xs font-semibold text-rose-900 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={deleteOpenAiByokKey}
                disabled={!openAiByokStatus?.configured || openAiByokLoading}
                className="rounded-lg border border-rose-300 bg-white/90 px-2.5 py-1.5 text-xs font-semibold text-rose-900 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Delete Key
              </button>
            </div>
          </div>
          <p className="text-xs leading-relaxed text-rose-900/90">
            Keys stay encrypted server-side and are not persisted in browser storage.
          </p>
          <input
            value={openAiByokInput}
            onChange={(event) => setOpenAiByokInput(event.target.value)}
            type="password"
            placeholder="Enter OpenAI API key (sk-...)"
            disabled={!user}
            className="w-full rounded-xl border border-rose-200 bg-white/95 px-3.5 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={saveOpenAiByokKey}
              disabled={openAiByokLoading || !user}
              className="rounded-xl border border-rose-700 bg-rose-700 px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-white transition hover:bg-rose-800 disabled:cursor-not-allowed disabled:border-slate-400 disabled:bg-slate-400"
            >
              {openAiByokLoading ? "Saving..." : "Save Key"}
            </button>
            <button
              type="button"
              onClick={() => setOpenAiByokInput("")}
              disabled={!user}
              className="rounded-xl border border-rose-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-rose-900 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear Input
            </button>
          </div>
          <p className="text-xs text-rose-800">
            Status: {vaultStatusText}
            {openAiByokStatus?.updatedAt ? ` | Updated ${formatTime(openAiByokStatus.updatedAt)}` : ""}
          </p>
        </div>

        <div className="mt-4 grid gap-3 rounded-2xl border border-[#c7d8d4] bg-[linear-gradient(165deg,rgba(238,252,249,0.86),rgba(250,255,254,0.94))] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs uppercase tracking-[0.17em] text-teal-900/70">Active Conversation</p>
              <p className="text-sm font-semibold text-teal-950">{conversationId}</p>
            </div>
            <button
              type="button"
              className="rounded-xl border border-teal-300 bg-white px-3.5 py-2 text-xs font-semibold uppercase tracking-[0.09em] text-teal-900 transition hover:bg-teal-50"
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
            placeholder="Ask about indexed documents..."
            rows={4}
            className="w-full rounded-xl border border-[#a9cbc4] bg-white/95 px-3.5 py-3 text-sm leading-relaxed text-slate-800 placeholder:text-slate-400"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-teal-900/80">
              {queryStateLabel} | {queryScopeLabel} | Prompt length: {query.length} characters
            </p>
            <div className="flex items-center gap-2">
              {effectiveQueryScopeId ? (
                <button
                  type="button"
                  onClick={() => setQueryDocumentScopeId(null)}
                  className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.11em] text-slate-700 transition hover:bg-slate-50"
                >
                  Clear Scope
                </button>
              ) : null}
              {!canQuery ? (
                <span className="rounded-full border border-slate-300 bg-slate-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.11em] text-slate-600">
                  Requires reader/admin
                </span>
              ) : null}
              <label className="flex items-center gap-1.5 text-xs text-teal-900/80">
                <input
                  type="checkbox"
                  checked={enableWebResearch}
                  onChange={(e) => setEnableWebResearch(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-teal-400 text-teal-700"
                  data-testid="web-research-toggle"
                />
                Web Research
              </label>
              <button
                type="button"
                disabled={!canQuery || isStreaming || query.trim().length === 0}
                onClick={executeQuery}
                className="rounded-xl border border-teal-700 bg-teal-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:border-slate-400 disabled:bg-slate-400"
              >
                {isStreaming ? "Streaming..." : "Send Query"}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-5 space-y-3">
          {turns.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-[#ccbdac] bg-white/70 px-4 py-10 text-center text-sm text-slate-500">
              No turns yet. Ask the first question to start a traceable response timeline.
            </p>
          ) : (
            turns.map((turn) => {
              const isActive = turn.id === activeTurn?.id;
              return (
                <article
                  key={turn.id}
                  className={`cursor-pointer rounded-2xl border p-4 transition md:p-5 ${
                    isActive
                      ? "border-teal-400 bg-teal-50/80 shadow-[0_14px_36px_-22px_rgba(15,118,110,0.8)]"
                      : "border-[#d8c9b5] bg-white/88 hover:border-[#b7a795] hover:bg-white"
                  }`}
                  onClick={() => setActiveTurnId(turn.id)}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{formatTime(turn.createdAt)}</p>
                    <div className="flex flex-wrap gap-1.5">
                      <span className="rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                        citations: {turn.citations.length}
                      </span>
                      {turn.retrievalMeta ? (
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                            turn.retrievalMeta.cacheHit
                              ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                              : "border-amber-300 bg-amber-50 text-amber-800"
                          }`}
                        >
                          cache: {turn.retrievalMeta.cacheHit ? "hit" : "miss"}
                        </span>
                      ) : null}
                      {turn.pending ? (
                        <span className="rounded-full border border-teal-300 bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-800">
                          streaming
                        </span>
                      ) : null}
                      {turn.failed ? (
                        <span className="rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-800">
                          failed
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <p className="mt-3 font-display text-xl leading-snug text-slate-900">{turn.query}</p>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{turn.answer || "..."}</p>
                  {turn.webSources && turn.webSources.length > 0 ? (
                    <div className="mt-3 space-y-1">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-800">Web Sources</p>
                      {turn.webSources.map((source) => (
                        <a
                          key={source.url}
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                          className="block rounded-lg border border-blue-200 bg-blue-50/60 px-2.5 py-1.5 text-xs text-blue-900 hover:bg-blue-100"
                        >
                          <span className="mr-1.5 inline-block rounded-full border border-blue-300 bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
                            external
                          </span>
                          {source.title}
                        </a>
                      ))}
                    </div>
                  ) : null}
                  {!turn.pending && !turn.failed && turn.queryHistoryId ? (
                    <div className="mt-3 flex gap-2" data-testid="report-downloads">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void downloadReport(turn.queryHistoryId!, "docx"); }}
                        className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        Download DOCX
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void downloadReport(turn.queryHistoryId!, "pdf"); }}
                        className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        Download PDF
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })
          )}
        </div>
      </section>

      <aside className="space-y-5">
        <section className="rounded-[24px] border border-[#dcc6a8] bg-[linear-gradient(155deg,rgba(255,248,233,0.92),rgba(255,253,246,0.9))] p-4 shadow-[0_20px_40px_-30px_rgba(120,53,15,0.5)]">
          <h3 className="text-sm font-semibold uppercase tracking-[0.17em] text-amber-950">Evidence Navigator</h3>
          <p className="mt-1 text-xs text-amber-900/80">Linked evidence for the currently selected answer.</p>
          <div className="mt-3 space-y-2">
            {activeTurn?.citations.length ? (
              activeTurn.citations.map((citation) => (
                <a
                  key={`${citation.documentId}:${citation.pageNumber}:${citation.chunkId}`}
                  className="block rounded-xl border border-amber-200 bg-white/90 px-3 py-2.5 text-xs text-slate-700 transition hover:bg-amber-50"
                  href={`/api/upload/${citation.documentId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <p>
                    <span className="font-semibold">Doc:</span> {citation.documentId}
                  </p>
                  <p>
                    <span className="font-semibold">Page:</span> {citation.pageNumber}
                  </p>
                  <p>
                    <span className="font-semibold">Chunk:</span> {citation.chunkId}
                  </p>
                </a>
              ))
            ) : (
              <p className="rounded-xl border border-dashed border-amber-300/70 bg-white/70 px-3 py-4 text-xs text-slate-500">
                No citations for this turn yet.
              </p>
            )}
          </div>
        </section>

        <section className="rounded-[24px] border border-[#b7d5c5] bg-[linear-gradient(160deg,rgba(233,250,242,0.9),rgba(247,255,252,0.95))] p-4 shadow-[0_20px_38px_-30px_rgba(5,150,105,0.5)]">
          <h3 className="text-sm font-semibold uppercase tracking-[0.17em] text-emerald-950">Ingestion Desk</h3>
          <div className="mt-3 space-y-2.5">
            <input
              ref={uploadFileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              className="block w-full text-xs text-emerald-900 file:mr-2 file:rounded-lg file:border file:border-emerald-300 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-emerald-900 hover:file:bg-emerald-50"
              onChange={handleUploadFileChange}
            />
            <input
              value={uploadTitle}
              onChange={(event) => setUploadTitle(event.target.value)}
              placeholder="Optional title"
              className="w-full rounded-xl border border-emerald-200 bg-white/95 px-3.5 py-2.5 text-sm text-slate-800 placeholder:text-slate-400"
            />
            <select
              value={uploadLanguageHint}
              onChange={(event) => setUploadLanguageHint(event.target.value)}
              className="w-full rounded-xl border border-emerald-200 bg-white/95 px-3.5 py-2.5 text-sm text-slate-800"
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
              onClick={handleUploadButtonClick}
              disabled={uploading}
              className="w-full rounded-xl border border-emerald-700 bg-emerald-700 px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:border-slate-400 disabled:bg-slate-400"
            >
              {uploading ? "Uploading..." : uploadFile ? "Upload PDF" : "Select PDF"}
            </button>
            {!canUpload ? (
              <p className="text-xs text-emerald-900/80">Create a session first. Current role: {user?.role ?? "none"}.</p>
            ) : !uploadFile ? (
              <p className="text-xs text-emerald-900/80">Select a PDF file to enable upload.</p>
            ) : (
              <p className="text-xs text-emerald-900/80">Selected file: {uploadFile.name}</p>
            )}
            {effectiveQueryScopeId ? (
              <p className="text-xs text-emerald-900/80">
                Query scope active for document {effectiveQueryScopeId}
              </p>
            ) : null}
          </div>

          <div className="mt-3 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-emerald-900/70">Batch Upload</p>
            <input
              ref={batchFileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              multiple
              className="block w-full text-xs text-emerald-900 file:mr-2 file:rounded-lg file:border file:border-emerald-300 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-emerald-900 hover:file:bg-emerald-50"
              onChange={handleBatchUpload}
              data-testid="batch-upload-input"
            />
            {batchFiles.length > 0 ? (
              <div className="space-y-1">
                {batchFiles.map((entry, index) => (
                  <div key={index} className="flex items-center gap-2 text-xs">
                    <span className="truncate text-slate-700">{entry.file.name}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        entry.status === "failed"
                          ? "border border-rose-300 bg-rose-50 text-rose-800"
                          : entry.status === "queued"
                            ? "border border-emerald-300 bg-emerald-50 text-emerald-800"
                            : entry.status === "uploading"
                              ? "border border-amber-300 bg-amber-50 text-amber-800"
                              : "border border-slate-300 bg-slate-50 text-slate-600"
                      }`}
                    >
                      {entry.status}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {uploadStatus ? (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-white/90 p-3 text-xs text-slate-700">
              <p>
                <span className="font-semibold">Document:</span> {uploadStatus.document.id}
              </p>
              <p>
                <span className="font-semibold">Status:</span> {uploadStatus.document.status}
              </p>
              <p>
                <span className="font-semibold">Job:</span> {uploadStatus.latestIngestionJob?.status ?? "n/a"}
              </p>
              {uploadStatus.latestIngestionJob?.last_error ? (
                <p>
                  <span className="font-semibold">Last error:</span> {uploadStatus.latestIngestionJob.last_error}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => uploadStatus && void handleDeleteDocumentById(uploadStatus.document.id)}
                className="mt-2 w-full rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-800 transition hover:bg-rose-100"
                data-testid="delete-document-button"
              >
                Delete Document
              </button>
            </div>
          ) : null}
        </section>

        {/* Document Library */}
        <section className="rounded-[24px] border border-[#d3c4b3] bg-[linear-gradient(165deg,rgba(255,252,248,0.95),rgba(251,247,241,0.95))] p-4 shadow-[0_20px_38px_-30px_rgba(71,85,105,0.55)]">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-[0.17em] text-slate-900">Documents</h3>
            <button
              type="button"
              onClick={() => void fetchDocuments()}
              className="rounded-lg border border-[#d3c4b3] bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-[#f6ede2]"
            >
              Refresh
            </button>
          </div>

          {documentsLoading && <p className="text-xs text-slate-500">Loading…</p>}

          {!documentsLoading && documents.length === 0 && (
            <p className="text-xs text-slate-500">No documents ingested yet.</p>
          )}

          {!documentsLoading && documents.length > 0 && (
            <ul className="max-h-72 space-y-2 overflow-y-auto">
              {documents.map((doc) => {
                const displayName = doc.title ?? doc.storage_path.split("/").pop() ?? doc.id.slice(0, 8);
                const isScoped = queryDocumentScopeId === doc.id;
                const statusColor = {
                  ready: "bg-emerald-100 text-emerald-700",
                  processing: "bg-amber-100 text-amber-700",
                  queued: "bg-slate-100 text-slate-500",
                  failed: "bg-rose-100 text-rose-700",
                }[doc.status];

                return (
                  <li key={doc.id} className="flex items-start gap-2 rounded-lg border border-slate-100 bg-white/80 p-2 text-xs">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-slate-700" title={displayName}>
                        {displayName}
                      </p>
                      <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusColor}`}>
                        {doc.status}
                      </span>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setQueryDocumentScopeId(isScoped ? null : doc.id);
                        }}
                        className={`rounded px-2 py-1 text-[10px] font-medium transition ${
                          isScoped
                            ? "bg-indigo-100 text-indigo-700 hover:bg-indigo-200"
                            : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                        }`}
                        title={isScoped ? "Remove scope" : "Scope queries to this document"}
                      >
                        {isScoped ? "Scoped" : "Scope"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteDocumentById(doc.id)}
                        className="rounded px-2 py-1 text-[10px] font-medium text-rose-600 transition hover:bg-rose-50"
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
        </section>

        <section className="rounded-[24px] border border-[#d3c4b3] bg-[linear-gradient(165deg,rgba(255,252,248,0.95),rgba(251,247,241,0.95))] p-4 shadow-[0_20px_38px_-30px_rgba(71,85,105,0.55)]">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold uppercase tracking-[0.17em] text-slate-900">Query Timeline</h3>
            <button
              type="button"
              onClick={() => void loadHistory()}
              className="rounded-lg border border-[#d3c4b3] bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-[#f6ede2]"
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
                  const scopedDocumentId = item.citations[0]?.documentId ?? null;
                  setQueryDocumentScopeId(scopedDocumentId);
                }}
                className="w-full rounded-xl border border-[#ddcec0] bg-white/85 px-3 py-2.5 text-left transition hover:border-[#c4b19d] hover:bg-white"
              >
                <p className="text-xs font-semibold text-slate-800">{item.query}</p>
                <p className="mt-1 text-[11px] text-slate-600">
                  {formatTime(item.createdAt)} | cache: {item.cacheHit ? "hit" : "miss"} | {item.latencyMs}ms
                </p>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-[24px] border border-[#d3c4b3] bg-[linear-gradient(165deg,rgba(255,252,248,0.95),rgba(251,247,241,0.95))] p-4 shadow-[0_20px_38px_-30px_rgba(51,65,85,0.55)]">
          <h3 className="text-sm font-semibold uppercase tracking-[0.17em] text-slate-900">Operations Log</h3>
          <p aria-live="polite" className={`mt-2 text-sm leading-relaxed ${workspaceToneClass}`}>
            {workspaceMessage}
          </p>
        </section>
      </aside>
    </div>
  );
}
