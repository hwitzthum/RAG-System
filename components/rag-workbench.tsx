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
} from "@/lib/contracts/api";
import { getCsrfToken, csrfHeaders } from "@/lib/security/csrf-client";

import { AppNav } from "@/components/layout/app-nav";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ChatView } from "@/components/workbench/chat-view";
import { ChatInput } from "@/components/workbench/chat-input";
import { SidebarLeft } from "@/components/workbench/sidebar-left";
import { SidebarRight } from "@/components/workbench/sidebar-right";
import { SessionSettings } from "@/components/workbench/session-settings";
import type { Turn, UploadStatusSnapshot, DocumentListItem } from "@/components/workbench/types";

type RagWorkbenchProps = {
  initialUser: AuthUser | null;
};

type ParsedSseEvent =
  | { event: "meta"; payload: QuerySseMetaEvent }
  | { event: "token"; payload: QuerySseTokenEvent }
  | { event: "final"; payload: QuerySseFinalEvent }
  | { event: "done"; payload: { queryId: string } }
  | null;

const QUERY_SCOPE_STORAGE_KEY = "rag.queryDocumentScopeId";

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
    if (eventName === "meta") return { event: "meta", payload: payload as QuerySseMetaEvent };
    if (eventName === "token") return { event: "token", payload: payload as QuerySseTokenEvent };
    if (eventName === "final") return { event: "final", payload: payload as QuerySseFinalEvent };
    if (eventName === "done") return { event: "done", payload: payload as { queryId: string } };
    return null;
  } catch {
    return null;
  }
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
      if (explicit) return explicit;
    }
    return turns[turns.length - 1] ?? null;
  }, [activeTurnId, turns]);

  const effectiveQueryScopeId = queryDocumentScopeId ?? uploadStatus?.document.id ?? null;

  // --- Data loading ---

  const loadHistory = useCallback(async (): Promise<void> => {
    if (!user) { setQueryHistory([]); return; }
    setHistoryLoading(true);
    try {
      const response = await fetch(`/api/query-history?limit=25`);
      if (!response.ok) { setWorkspaceMessage("Failed to load query history."); return; }
      const payload = (await response.json()) as QueryHistoryResponse;
      setQueryHistory(payload.items ?? []);
    } finally {
      setHistoryLoading(false);
    }
  }, [user]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const persisted = window.localStorage.getItem(QUERY_SCOPE_STORAGE_KEY);
    if (persisted) setQueryDocumentScopeId(persisted);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (queryDocumentScopeId) {
      window.localStorage.setItem(QUERY_SCOPE_STORAGE_KEY, queryDocumentScopeId);
    } else {
      window.localStorage.removeItem(QUERY_SCOPE_STORAGE_KEY);
    }
  }, [queryDocumentScopeId]);

  async function fetchDocuments(): Promise<void> {
    setDocumentsLoading(true);
    try {
      const res = await fetch("/api/documents");
      if (!res.ok) { setWorkspaceMessage("Failed to load documents."); return; }
      const json = (await res.json()) as { documents: DocumentListItem[] };
      setDocuments(json.documents);
    } finally {
      setDocumentsLoading(false);
    }
  }

  useEffect(() => {
    if (user) void fetchDocuments();
    else setDocuments([]);
  }, [user]);

  // Inactivity logout
  useEffect(() => {
    if (!user) return;
    const INACTIVITY_MS = 10 * 60 * 1000;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { void clearSession(); }, INACTIVITY_MS);
    };
    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "click"] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [user]);

  const loadOpenAiByokStatus = useCallback(async (): Promise<void> => {
    if (!user) { setOpenAiByokStatus(null); return; }
    setOpenAiByokLoading(true);
    try {
      const response = await fetch("/api/byok/openai");
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

  useEffect(() => { void loadOpenAiByokStatus(); }, [loadOpenAiByokStatus]);

  // --- Actions ---

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
    if (!user) { setWorkspaceMessage("Create a session before configuring OpenAI BYOK."); return; }
    if (!openAiByokInput.trim()) { setWorkspaceMessage("Enter an OpenAI API key first."); return; }
    setOpenAiByokLoading(true);
    try {
      const response = await fetch("/api/byok/openai", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ apiKey: openAiByokInput }),
      });
      const payload = (await response.json()) as OpenAiByokStatusResponse & { error?: string };
      if (!response.ok) { setWorkspaceMessage(payload.error ?? "Failed to save OpenAI API key."); return; }
      setOpenAiByokStatus(payload);
      setOpenAiByokInput("");
      setWorkspaceMessage("OpenAI BYOK key stored in encrypted vault.");
    } finally {
      setOpenAiByokLoading(false);
    }
  }

  async function deleteOpenAiByokKey(): Promise<void> {
    if (!user) return;
    setOpenAiByokLoading(true);
    try {
      const response = await fetch("/api/byok/openai", { method: "DELETE", headers: csrfHeaders() });
      const payload = (await response.json()) as OpenAiByokStatusResponse & { error?: string };
      if (!response.ok) { setWorkspaceMessage(payload.error ?? "Failed to remove OpenAI API key."); return; }
      setOpenAiByokStatus(payload);
      setWorkspaceMessage("OpenAI BYOK key removed from vault.");
    } finally {
      setOpenAiByokLoading(false);
    }
  }

  async function refreshUploadStatus(documentId: string): Promise<UploadStatusSnapshot | null> {
    const response = await fetch(`/api/upload/${documentId}`);
    if (!response.ok) { setWorkspaceMessage("Unable to fetch upload status."); return null; }
    const payload = (await response.json()) as UploadStatusSnapshot;
    setUploadStatus(payload);
    return payload;
  }

  async function waitForUploadTerminalStatus(documentId: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const snapshot = await refreshUploadStatus(documentId);
      if (!snapshot) return;
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
    if (!user) { setWorkspaceMessage("Create a session before uploading documents."); return; }
    const fileToUpload = selectedFile ?? uploadFile;
    if (!fileToUpload) { setWorkspaceMessage("Select a PDF file first."); return; }
    if (fileToUpload.type !== "application/pdf" && !fileToUpload.name.toLowerCase().endsWith(".pdf")) {
      setWorkspaceMessage("Only PDF files are supported.");
      return;
    }
    setUploading(true);
    const formData = new FormData();
    formData.append("file", fileToUpload);
    formData.append("title", uploadTitle.trim() || fileToUpload.name);
    if (uploadLanguageHint) formData.append("language_hint", uploadLanguageHint);
    try {
      const response = await fetch("/api/upload", { method: "POST", headers: csrfHeaders(), body: formData });
      const payload = (await response.json()) as { documentId?: string; error?: string };
      if (!response.ok || !payload.documentId) { setWorkspaceMessage(payload.error ?? "Upload failed."); return; }
      setWorkspaceMessage(`Upload accepted. documentId=${payload.documentId}. Indexing started...`);
      setQueryDocumentScopeId(payload.documentId);
      setUploadFile(null);
      if (uploadFileInputRef.current) uploadFileInputRef.current.value = "";
      await waitForUploadTerminalStatus(payload.documentId);
      await fetchDocuments();
    } finally {
      setUploading(false);
    }
  }

  function handleUploadFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const selected = event.target.files?.[0] ?? null;
    setUploadFile(selected);
    if (!selected) return;
    if (!user) { setWorkspaceMessage("File selected. Create a session before uploading."); return; }
    void uploadPdf(selected);
  }

  function handleUploadButtonClick(): void {
    if (uploading) return;
    if (!uploadFile) { uploadFileInputRef.current?.click(); setWorkspaceMessage("Select a PDF file first."); return; }
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
      formData.append("title", entries[i].file.name);
      try {
        const response = await fetch("/api/upload/batch", { method: "POST", headers: csrfHeaders(), body: formData });
        const payload = (await response.json()) as { documentId?: string; error?: string };
        if (!response.ok || !payload.documentId) {
          setBatchFiles((prev) => prev.map((e, j) => (j === i ? { ...e, status: "failed", error: payload.error ?? "Upload failed" } : e)));
        } else {
          setBatchFiles((prev) => prev.map((e, j) => (j === i ? { ...e, status: "queued", documentId: payload.documentId } : e)));
        }
      } catch {
        setBatchFiles((prev) => prev.map((e, j) => (j === i ? { ...e, status: "failed", error: "Network error" } : e)));
      }
    }
    setWorkspaceMessage(`Batch upload complete: ${entries.length} files processed.`);
    await fetchDocuments();
  }

  async function handleDeleteDocumentById(docId: string): Promise<void> {
    const res = await fetch(`/api/documents/${docId}`, { method: "DELETE", headers: csrfHeaders() });
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

  const downloadReportCb = useCallback(async (queryHistoryId: string, format: "docx" | "pdf"): Promise<void> => {
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
  }, []);

  async function executeQuery(): Promise<void> {
    if (!canQuery || !query.trim() || isStreaming) return;

    const question = query.trim();
    setQuery("");
    setWorkspaceMessage("Query in progress...");
    setIsStreaming(true);

    const turnId = newUuid();
    const pendingTurn: Turn = {
      id: turnId,
      conversationId,
      query: question,
      answer: "",
      citations: [],
      pending: true,
      failed: false,
      retrievalMeta: null,
      createdAt: new Date().toISOString(),
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
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundaryIndex = buffer.indexOf("\n\n");
        while (boundaryIndex !== -1) {
          const rawBlock = buffer.slice(0, boundaryIndex).trim();
          buffer = buffer.slice(boundaryIndex + 2);
          boundaryIndex = buffer.indexOf("\n\n");
          if (!rawBlock) continue;
          const parsed = parseSseEventBlock(rawBlock);
          if (!parsed) continue;
          if (parsed.event === "meta") {
            patchTurn(turnId, (turn) => ({
              ...turn,
              retrievalMeta: parsed.payload.retrievalMeta,
              conversationId: parsed.payload.retrievalMeta.conversationId ?? turn.conversationId,
            }));
            setConversationId(parsed.payload.retrievalMeta.conversationId ?? conversationId);
          } else if (parsed.event === "token") {
            patchTurn(turnId, (turn) => ({ ...turn, answer: `${turn.answer}${parsed.payload.token}` }));
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
            patchTurn(turnId, (turn) => ({ ...turn, pending: false }));
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

  function handleRestoreHistory(item: QueryHistoryItem): void {
    setConversationId(item.conversationId ?? newUuid());
    setQuery(item.query);
    const scopedDocumentId = item.citations[0]?.documentId ?? null;
    setQueryDocumentScopeId(scopedDocumentId);
  }

  return (
    <ErrorBoundary>
      <AppNav user={user} onSignOut={() => void clearSession()} />

      <h1 className="sr-only">Response Workspace</h1>
      <h2 className="sr-only">Grounded Answer Operations</h2>

      <div className="flex h-[calc(100vh-3.5rem)]">
        <SidebarLeft
          documents={documents}
          documentsLoading={documentsLoading}
          queryDocumentScopeId={queryDocumentScopeId}
          setQueryDocumentScopeId={setQueryDocumentScopeId}
          onDeleteDocument={(id) => void handleDeleteDocumentById(id)}
          onRefreshDocuments={() => void fetchDocuments()}
          queryHistory={queryHistory}
          historyLoading={historyLoading}
          onRefreshHistory={() => void loadHistory()}
          onRestoreHistory={handleRestoreHistory}
        />

        <div className="flex flex-1 flex-col overflow-hidden">
          <ChatView
            turns={turns}
            activeTurn={activeTurn}
            setActiveTurnId={setActiveTurnId}
            downloadReport={downloadReportCb}
          />
          <ChatInput
            query={query}
            setQuery={setQuery}
            executeQuery={() => void executeQuery()}
            isStreaming={isStreaming}
            enableWebResearch={enableWebResearch}
            setEnableWebResearch={setEnableWebResearch}
            canQuery={canQuery}
            effectiveQueryScopeId={effectiveQueryScopeId}
            onClearScope={() => setQueryDocumentScopeId(null)}
          />
          {process.env.NODE_ENV === "development" && (
            <SessionSettings
              user={user}
              token={token}
              setToken={setToken}
              createSession={() => void createSession()}
              clearSession={() => void clearSession()}
              openAiByokInput={openAiByokInput}
              setOpenAiByokInput={setOpenAiByokInput}
              openAiByokStatus={openAiByokStatus}
              openAiByokLoading={openAiByokLoading}
              saveOpenAiByokKey={() => void saveOpenAiByokKey()}
              deleteOpenAiByokKey={() => void deleteOpenAiByokKey()}
              loadOpenAiByokStatus={() => void loadOpenAiByokStatus()}
            />
          )}
        </div>

        <SidebarRight
          activeTurn={activeTurn}
          uploadFileInputRef={uploadFileInputRef}
          handleUploadFileChange={handleUploadFileChange}
          uploadTitle={uploadTitle}
          setUploadTitle={setUploadTitle}
          uploadLanguageHint={uploadLanguageHint}
          setUploadLanguageHint={setUploadLanguageHint}
          handleUploadButtonClick={handleUploadButtonClick}
          uploading={uploading}
          uploadFile={uploadFile}
          canUpload={canUpload}
          userRole={user?.role ?? null}
          effectiveQueryScopeId={effectiveQueryScopeId}
          batchFileInputRef={batchFileInputRef}
          handleBatchUpload={(e) => void handleBatchUpload(e)}
          batchFiles={batchFiles}
          uploadStatus={uploadStatus}
          onDeleteDocument={(id) => void handleDeleteDocumentById(id)}
          workspaceMessage={workspaceMessage}
        />
      </div>
    </ErrorBoundary>
  );
}
