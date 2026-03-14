"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { Toaster, toast } from "sonner";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { AuthUser } from "@/lib/auth/types";
import type {
  ProviderByokStatusResponse,
  QueryHistoryItem,
  QueryHistoryResponse,
  QuerySseFinalEvent,
  QuerySseMetaEvent,
  QuerySseTokenEvent,
} from "@/lib/contracts/api";
import { csrfHeaders } from "@/lib/security/csrf-client";

import { AppNav } from "@/components/layout/app-nav";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ChatView } from "@/components/workbench/chat-view";
import { ChatInput } from "@/components/workbench/chat-input";
import { SidebarLeft } from "@/components/workbench/sidebar-left";
import { SidebarRight } from "@/components/workbench/sidebar-right";
import { DevSessionControls } from "@/components/workbench/dev-session-controls";
import { getDocumentDisplayName } from "@/components/workbench/types";
import type {
  Turn,
  UploadStatusSnapshot,
  DocumentListItem,
  ProviderKeyVaultProps,
} from "@/components/workbench/types";

type RagWorkbenchProps = {
  initialUser: AuthUser | null;
};

type ParsedSseEvent =
  | { event: "meta"; payload: QuerySseMetaEvent }
  | { event: "token"; payload: QuerySseTokenEvent }
  | { event: "final"; payload: QuerySseFinalEvent }
  | { event: "done"; payload: { queryId: string } }
  | null;

const QUERY_SCOPE_STORAGE_KEY = "rag.queryDocumentScopeIds";

function normalizeScopedDocumentIds(input: string[]): string[] {
  return [...new Set(input.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function parsePersistedScopeIds(rawValue: string | null): string[] {
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (Array.isArray(parsed)) {
      return normalizeScopedDocumentIds(parsed.filter((value): value is string => typeof value === "string"));
    }
  } catch {
    return normalizeScopedDocumentIds([rawValue]);
  }

  return [];
}

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
  const [openAiByokStatus, setOpenAiByokStatus] = useState<ProviderByokStatusResponse | null>(null);
  const [openAiByokLoading, setOpenAiByokLoading] = useState(false);
  const [cohereByokInput, setCohereByokInput] = useState("");
  const [cohereByokStatus, setCohereByokStatus] = useState<ProviderByokStatusResponse | null>(null);
  const [cohereByokLoading, setCohereByokLoading] = useState(false);
  const [anthropicByokInput, setAnthropicByokInput] = useState("");
  const [anthropicByokStatus, setAnthropicByokStatus] = useState<ProviderByokStatusResponse | null>(null);
  const [anthropicByokLoading, setAnthropicByokLoading] = useState(false);
  const [conversationId, setConversationId] = useState(newUuid);
  const [query, setQuery] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [queryHistory, setQueryHistory] = useState<QueryHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [workspaceMessage, setWorkspaceMessage] = useState("Ready.");
  const [enableWebResearch, setEnableWebResearch] = useState(false);
  const [enableQueryExpansion, setEnableQueryExpansion] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"none" | "left" | "right">("none");

  const [batchFiles, setBatchFiles] = useState<Array<{ file: File; status: string; error?: string; documentId?: string }>>([]);
  const batchFileInputRef = useRef<HTMLInputElement | null>(null);

  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadLanguageHint, setUploadLanguageHint] = useState("");
  const [uploadStatus, setUploadStatus] = useState<UploadStatusSnapshot | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadFileInputRef = useRef<HTMLInputElement | null>(null);
  const [queryDocumentScopeIds, setQueryDocumentScopeIds] = useState<string[]>([]);
  const [documents, setDocuments] = useState<DocumentListItem[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const queryInFlightRef = useRef(false);
  const uploadInFlightRef = useRef(false);
  const deletingDocumentIdsRef = useRef(new Set<string>());

  const canQuery = user?.role === "reader" || user?.role === "admin";
  const canUpload = Boolean(user);
  const canDeleteDocuments = user?.role === "admin";

  const activeTurn = useMemo(() => {
    if (activeTurnId) {
      const explicit = turns.find((turn) => turn.id === activeTurnId);
      if (explicit) return explicit;
    }
    return turns[turns.length - 1] ?? null;
  }, [activeTurnId, turns]);

  const effectiveQueryScopeIds = queryDocumentScopeIds;
  const canUseQueryExpansion = effectiveQueryScopeIds.length > 1;

  const scopeSummary = useMemo(() => {
    if (effectiveQueryScopeIds.length === 0) {
      return null;
    }

    const labels = effectiveQueryScopeIds
      .map((documentId) => {
        const doc = documents.find((item) => item.id === documentId);
        return doc ? getDocumentDisplayName(doc) : documentId.slice(0, 8);
      })
      .slice(0, 3);

    if (effectiveQueryScopeIds.length === 1) {
      return labels[0] ?? "1 document";
    }

    if (effectiveQueryScopeIds.length <= 3) {
      return labels.join(", ");
    }

    return `${labels.join(", ")} +${effectiveQueryScopeIds.length - labels.length}`;
  }, [effectiveQueryScopeIds, documents]);

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
    setQueryDocumentScopeIds(parsePersistedScopeIds(persisted));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (queryDocumentScopeIds.length > 0) {
      window.localStorage.setItem(QUERY_SCOPE_STORAGE_KEY, JSON.stringify(queryDocumentScopeIds));
    } else {
      window.localStorage.removeItem(QUERY_SCOPE_STORAGE_KEY);
    }
  }, [queryDocumentScopeIds]);

  useEffect(() => {
    if (!canUseQueryExpansion && enableQueryExpansion) {
      setEnableQueryExpansion(false);
    }
  }, [canUseQueryExpansion, enableQueryExpansion]);

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

  const toggleQueryDocumentScopeId = useCallback((documentId: string): void => {
    setQueryDocumentScopeIds((current) =>
      current.includes(documentId)
        ? current.filter((id) => id !== documentId)
        : [...current, documentId],
    );
  }, []);

  const clearQueryDocumentScope = useCallback((): void => {
    setQueryDocumentScopeIds([]);
  }, []);

  const clearSession = useCallback(async (): Promise<void> => {
    await fetch("/api/auth/session", { method: "DELETE", headers: csrfHeaders() });
    await getSupabaseBrowserClient().auth.signOut().catch(() => null);
    setUser(null);
    setOpenAiByokInput("");
    setOpenAiByokStatus(null);
    setCohereByokInput("");
    setCohereByokStatus(null);
    setAnthropicByokInput("");
    setAnthropicByokStatus(null);
    setTurns([]);
    setQueryHistory([]);
    setQueryDocumentScopeIds([]);
    router.push("/login");
  }, [router]);

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
  }, [user, clearSession]);

  const loadProviderByokStatus = useCallback(async (
    providerSlug: "openai" | "cohere" | "anthropic",
    setters: {
      setStatus: (status: ProviderByokStatusResponse | null) => void;
      setLoading: (loading: boolean) => void;
    },
  ): Promise<void> => {
    if (!user) {
      setters.setStatus(null);
      return;
    }
    setters.setLoading(true);
    try {
      const response = await fetch(`/api/byok/${providerSlug}`);
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setWorkspaceMessage(payload.error ?? `Unable to load ${providerSlug} BYOK status.`);
        return;
      }
      const payload = (await response.json()) as ProviderByokStatusResponse;
      setters.setStatus(payload);
    } finally {
      setters.setLoading(false);
    }
  }, [user]);

  const loadOpenAiByokStatus = useCallback(async (): Promise<void> => {
    return loadProviderByokStatus("openai", {
      setStatus: setOpenAiByokStatus,
      setLoading: setOpenAiByokLoading,
    });
  }, [loadProviderByokStatus]);

  const loadCohereByokStatus = useCallback(async (): Promise<void> => {
    return loadProviderByokStatus("cohere", {
      setStatus: setCohereByokStatus,
      setLoading: setCohereByokLoading,
    });
  }, [loadProviderByokStatus]);

  const loadAnthropicByokStatus = useCallback(async (): Promise<void> => {
    return loadProviderByokStatus("anthropic", {
      setStatus: setAnthropicByokStatus,
      setLoading: setAnthropicByokLoading,
    });
  }, [loadProviderByokStatus]);

  useEffect(() => {
    void loadOpenAiByokStatus();
    void loadCohereByokStatus();
    void loadAnthropicByokStatus();
  }, [loadAnthropicByokStatus, loadCohereByokStatus, loadOpenAiByokStatus]);

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
      toast.error(payload.error ?? "Session creation failed.");
      return;
    }
    setUser(payload.user);
    setWorkspaceMessage(`Session created for role=${payload.user.role}.`);
    toast.success(`Session created for role=${payload.user.role}.`);
  }

  const saveProviderByokKey = useCallback(async (input: {
    providerSlug: "openai" | "cohere" | "anthropic";
    providerLabel: string;
    apiKey: string;
    setStatus: (status: ProviderByokStatusResponse | null) => void;
    setInput: (value: string) => void;
    setLoading: (loading: boolean) => void;
  }): Promise<void> => {
    if (!user) {
      setWorkspaceMessage(`Create a session before configuring ${input.providerLabel} BYOK.`);
      return;
    }
    if (!input.apiKey.trim()) {
      setWorkspaceMessage(`Enter a ${input.providerLabel} API key first.`);
      return;
    }
    input.setLoading(true);
    try {
      const response = await fetch(`/api/byok/${input.providerSlug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ apiKey: input.apiKey }),
      });
      const payload = (await response.json()) as ProviderByokStatusResponse & { error?: string };
      if (!response.ok) {
        setWorkspaceMessage(payload.error ?? `Failed to save ${input.providerLabel} API key.`);
        toast.error(payload.error ?? `Failed to save ${input.providerLabel} API key.`);
        return;
      }
      input.setStatus(payload);
      input.setInput("");
      setWorkspaceMessage(`${input.providerLabel} BYOK key stored in encrypted vault.`);
      toast.success(`${input.providerLabel} BYOK key stored in encrypted vault.`);
    } finally {
      input.setLoading(false);
    }
  }, [user]);

  const deleteProviderByokKey = useCallback(async (input: {
    providerSlug: "openai" | "cohere" | "anthropic";
    providerLabel: string;
    setStatus: (status: ProviderByokStatusResponse | null) => void;
    setLoading: (loading: boolean) => void;
  }): Promise<void> => {
    if (!user) return;
    input.setLoading(true);
    try {
      const response = await fetch(`/api/byok/${input.providerSlug}`, {
        method: "DELETE",
        headers: csrfHeaders(),
      });
      const payload = (await response.json()) as ProviderByokStatusResponse & { error?: string };
      if (!response.ok) {
        setWorkspaceMessage(payload.error ?? `Failed to remove ${input.providerLabel} API key.`);
        toast.error(payload.error ?? `Failed to remove ${input.providerLabel} API key.`);
        return;
      }
      input.setStatus(payload);
      setWorkspaceMessage(`${input.providerLabel} BYOK key removed from vault.`);
      toast.success(`${input.providerLabel} BYOK key removed from vault.`);
    } finally {
      input.setLoading(false);
    }
  }, [user]);

  async function refreshUploadStatus(documentId: string): Promise<UploadStatusSnapshot | null> {
    const response = await fetch(`/api/upload/${documentId}`);
    if (!response.ok) { setWorkspaceMessage("Unable to fetch upload status."); return null; }
    const payload = (await response.json()) as UploadStatusSnapshot;
    setUploadStatus(payload);
    return payload;
  }

  async function waitForUploadTerminalStatus(documentId: string): Promise<void> {
    const MAX_POLLS = 60; // 60 × 3s = 3 minutes
    for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
      const snapshot = await refreshUploadStatus(documentId);
      if (!snapshot) return;
      const documentStatus = snapshot.document.status;
      const jobStatus = snapshot.latestIngestionJob?.status ?? "unknown";
      if (documentStatus === "ready") {
        setWorkspaceMessage(`Upload indexed and ready. documentId=${documentId}`);
        toast.success("Document indexed and ready.");
        void fetchDocuments();
        return;
      }
      if (documentStatus === "failed" || jobStatus === "dead_letter" || jobStatus === "failed") {
        const errorMsg = snapshot.latestIngestionJob?.last_error
          ? `Upload failed: ${snapshot.latestIngestionJob.last_error}`
          : `Upload failed. document status=${documentStatus}, job status=${jobStatus}`;
        setWorkspaceMessage(errorMsg);
        toast.error("Upload failed.");
        void fetchDocuments();
        return;
      }
      if (attempt > 0 && attempt % 10 === 0) {
        setWorkspaceMessage(`Still processing PDF... (${attempt * 3}s elapsed)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    setWorkspaceMessage("Processing is taking longer than expected. Check back shortly.");
    void fetchDocuments();
  }

  async function uploadPdf(selectedFile?: File): Promise<void> {
    if (!user) { setWorkspaceMessage("Create a session before uploading documents."); return; }
    if (uploadInFlightRef.current) { return; }
    const fileToUpload = selectedFile ?? uploadFile;
    if (!fileToUpload) { setWorkspaceMessage("Select a PDF file first."); return; }
    if (fileToUpload.type !== "application/pdf" && !fileToUpload.name.toLowerCase().endsWith(".pdf")) {
      setWorkspaceMessage("Only PDF files are supported.");
      return;
    }
    uploadInFlightRef.current = true;
    setUploading(true);
    setWorkspaceMessage("Uploading and processing PDF...");
    const formData = new FormData();
    formData.append("file", fileToUpload);
    formData.append("title", uploadTitle.trim() || fileToUpload.name);
    if (uploadLanguageHint) formData.append("language_hint", uploadLanguageHint);
    try {
      const response = await fetch("/api/upload", { method: "POST", headers: csrfHeaders(), body: formData });
      const payload = (await response.json()) as { documentId?: string; error?: string };
      if (!response.ok || !payload.documentId) {
        setWorkspaceMessage(payload.error ?? "Upload failed.");
        toast.error(payload.error ?? "Upload failed.");
        return;
      }
      setWorkspaceMessage(`Upload accepted. documentId=${payload.documentId}. Indexing started...`);
      toast.success("Upload accepted. Indexing started...");
      setQueryDocumentScopeIds([payload.documentId]);
      await waitForUploadTerminalStatus(payload.documentId);
      setUploadFile(null);
      setUploadTitle("");
      setUploadLanguageHint("");
      if (uploadFileInputRef.current) uploadFileInputRef.current.value = "";
      await fetchDocuments();
    } finally {
      uploadInFlightRef.current = false;
      setUploading(false);
    }
  }

  function handleUploadFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const selected = event.target.files?.[0] ?? null;
    setUploadFile(selected);
    setUploadTitle(selected?.name ?? "");
    if (!selected) {
      return;
    }
    if (!user) {
      setWorkspaceMessage("File selected. Create a session before uploading.");
      return;
    }
    setWorkspaceMessage("PDF selected. Review details and click Upload PDF.");
  }

  function handleUploadButtonClick(): void {
    if (uploading || uploadInFlightRef.current) return;
    if (!uploadFile) { uploadFileInputRef.current?.click(); return; }
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
      formData.append("files", entries[i].file);
      try {
        const response = await fetch("/api/upload/batch", { method: "POST", headers: csrfHeaders(), body: formData });
        const payload = (await response.json()) as { results?: Array<{ documentId?: string; status: string; error?: string }> };
        const first = payload.results?.[0];
        if (!response.ok || !first || first.status !== "accepted" || !first.documentId) {
          setBatchFiles((prev) => prev.map((e, j) => (j === i ? { ...e, status: "failed", error: first?.error ?? "Upload failed" } : e)));
        } else {
          setBatchFiles((prev) => prev.map((e, j) => (j === i ? { ...e, status: "queued", documentId: first.documentId } : e)));
        }
      } catch {
        setBatchFiles((prev) => prev.map((e, j) => (j === i ? { ...e, status: "failed", error: "Network error" } : e)));
      }
    }
    setWorkspaceMessage(`Batch upload complete: ${entries.length} files processed.`);
    toast.success(`Batch upload complete: ${entries.length} files processed.`);
    await fetchDocuments();
  }

  async function handleDeleteDocumentById(docId: string): Promise<void> {
    if (!canDeleteDocuments) {
      setWorkspaceMessage("Only admins can delete documents.");
      return;
    }
    if (deletingDocumentIdsRef.current.has(docId)) {
      return;
    }
    deletingDocumentIdsRef.current.add(docId);
    try {
      const res = await fetch(`/api/documents/${docId}`, { method: "DELETE", headers: csrfHeaders() });
      if (res.ok) {
        if (uploadStatus?.document.id === docId) setUploadStatus(null);
        if (queryDocumentScopeIds.includes(docId)) {
          setQueryDocumentScopeIds((current) => current.filter((id) => id !== docId));
        }
        await fetchDocuments();
        setWorkspaceMessage("Document deleted.");
        toast.success("Document deleted.");
      } else {
        setWorkspaceMessage("Failed to delete document.");
        toast.error("Failed to delete document.");
      }
    } catch {
      setWorkspaceMessage("Failed to delete document.");
      toast.error("Failed to delete document.");
    } finally {
      deletingDocumentIdsRef.current.delete(docId);
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
        toast.error(payload.error ?? "Report generation failed.");
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
      toast.success(`${format.toUpperCase()} report downloaded.`);
    } catch {
      setWorkspaceMessage("Report download failed.");
      toast.error("Report download failed.");
    }
  }, []);

  async function executeQuery(): Promise<void> {
    if (!canQuery || !query.trim() || isStreaming || queryInFlightRef.current) return;

    const question = query.trim();
    queryInFlightRef.current = true;
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
          documentIds:
            (queryDocumentScopeIds.length > 0
              ? queryDocumentScopeIds
              : uploadStatus?.document.id
                ? [uploadStatus.document.id]
                : undefined),
          enableWebResearch: enableWebResearch || undefined,
          enableQueryExpansion: canUseQueryExpansion && enableQueryExpansion ? true : undefined,
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
      const msg = error instanceof Error ? error.message : "Query failed.";
      setWorkspaceMessage(msg);
      toast.error(msg);
    } finally {
      queryInFlightRef.current = false;
      setIsStreaming(false);
    }
  }

  function handleRestoreHistory(item: QueryHistoryItem): void {
    setConversationId(item.conversationId ?? newUuid());
    setQuery(item.query);
    const scopedDocumentIds = normalizeScopedDocumentIds(item.citations.map((citation) => citation.documentId));
    setQueryDocumentScopeIds(scopedDocumentIds);
  }

  function handleNewConversation(): void {
    setConversationId(newUuid());
    setTurns([]);
    setActiveTurnId(null);
    setQuery("");
  }

  const providerVaults = useMemo<ProviderKeyVaultProps[]>(() => [
    {
      providerLabel: "OpenAI",
      providerSlug: "openai",
      placeholder: "OpenAI API key (sk-...)",
      user,
      inputValue: openAiByokInput,
      setInputValue: setOpenAiByokInput,
      status: openAiByokStatus,
      loading: openAiByokLoading,
      saveKey: () => void saveProviderByokKey({
        providerSlug: "openai",
        providerLabel: "OpenAI",
        apiKey: openAiByokInput,
        setStatus: setOpenAiByokStatus,
        setInput: setOpenAiByokInput,
        setLoading: setOpenAiByokLoading,
      }),
      deleteKey: () => void deleteProviderByokKey({
        providerSlug: "openai",
        providerLabel: "OpenAI",
        setStatus: setOpenAiByokStatus,
        setLoading: setOpenAiByokLoading,
      }),
      loadStatus: () => void loadOpenAiByokStatus(),
    },
    {
      providerLabel: "Cohere",
      providerSlug: "cohere",
      placeholder: "Cohere API key",
      user,
      inputValue: cohereByokInput,
      setInputValue: setCohereByokInput,
      status: cohereByokStatus,
      loading: cohereByokLoading,
      saveKey: () => void saveProviderByokKey({
        providerSlug: "cohere",
        providerLabel: "Cohere",
        apiKey: cohereByokInput,
        setStatus: setCohereByokStatus,
        setInput: setCohereByokInput,
        setLoading: setCohereByokLoading,
      }),
      deleteKey: () => void deleteProviderByokKey({
        providerSlug: "cohere",
        providerLabel: "Cohere",
        setStatus: setCohereByokStatus,
        setLoading: setCohereByokLoading,
      }),
      loadStatus: () => void loadCohereByokStatus(),
    },
    {
      providerLabel: "Anthropic",
      providerSlug: "anthropic",
      placeholder: "Anthropic API key",
      user,
      inputValue: anthropicByokInput,
      setInputValue: setAnthropicByokInput,
      status: anthropicByokStatus,
      loading: anthropicByokLoading,
      saveKey: () => void saveProviderByokKey({
        providerSlug: "anthropic",
        providerLabel: "Anthropic",
        apiKey: anthropicByokInput,
        setStatus: setAnthropicByokStatus,
        setInput: setAnthropicByokInput,
        setLoading: setAnthropicByokLoading,
      }),
      deleteKey: () => void deleteProviderByokKey({
        providerSlug: "anthropic",
        providerLabel: "Anthropic",
        setStatus: setAnthropicByokStatus,
        setLoading: setAnthropicByokLoading,
      }),
      loadStatus: () => void loadAnthropicByokStatus(),
    },
  ], [
    anthropicByokInput,
    anthropicByokLoading,
    anthropicByokStatus,
    cohereByokInput,
    cohereByokLoading,
    cohereByokStatus,
    deleteProviderByokKey,
    loadAnthropicByokStatus,
    loadCohereByokStatus,
    loadOpenAiByokStatus,
    openAiByokInput,
    openAiByokLoading,
    openAiByokStatus,
    saveProviderByokKey,
    user,
  ]);

  return (
    <ErrorBoundary>
      <Toaster position="bottom-right" richColors />
      <AppNav
        user={user}
        onSignOut={() => void clearSession()}
        onToggleLeftPanel={() => setMobilePanel((p) => p === "left" ? "none" : "left")}
        onToggleRightPanel={() => setMobilePanel((p) => p === "right" ? "none" : "right")}
      />

      <h1 className="sr-only">Response Workspace</h1>
      <h2 className="sr-only">Grounded Answer Operations</h2>

      {/* Mobile overlay backdrop */}
      {mobilePanel !== "none" && (
        <div
          className="fixed inset-0 z-30 bg-black/20 lg:hidden"
          onClick={() => setMobilePanel("none")}
        />
      )}

      <div className="flex h-[calc(100vh-3.5rem)]">
        {/* Left sidebar - mobile overlay */}
        {mobilePanel === "left" && (
          <div className="fixed inset-y-14 left-0 z-40 w-[280px] border-r border-zinc-200 bg-white lg:hidden">
            <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
              <button
                type="button"
                onClick={handleNewConversation}
                className="w-full rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 transition hover:bg-indigo-100 active:scale-[0.98]"
              >
                + New Chat
              </button>
              {/* Simplified mobile sidebar content */}
              <p className="text-xs text-zinc-400">Use desktop view for full sidebar.</p>
            </div>
          </div>
        )}

        <SidebarLeft
          documents={documents}
          documentsLoading={documentsLoading}
          canDeleteDocuments={canDeleteDocuments}
          queryDocumentScopeIds={queryDocumentScopeIds}
          toggleQueryDocumentScopeId={toggleQueryDocumentScopeId}
          onDeleteDocument={(id) => void handleDeleteDocumentById(id)}
          onRefreshDocuments={() => void fetchDocuments()}
          queryHistory={queryHistory}
          historyLoading={historyLoading}
          onRefreshHistory={() => void loadHistory()}
          onRestoreHistory={handleRestoreHistory}
          onNewConversation={handleNewConversation}
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
            enableQueryExpansion={enableQueryExpansion}
            setEnableQueryExpansion={setEnableQueryExpansion}
            canQuery={canQuery}
            effectiveQueryScopeIds={effectiveQueryScopeIds}
            scopeSummary={scopeSummary}
            onClearScope={clearQueryDocumentScope}
          />
          {process.env.NODE_ENV === "development" && (
            <DevSessionControls
              token={token}
              setToken={setToken}
              createSession={() => void createSession()}
              clearSession={() => void clearSession()}
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
          canDeleteDocuments={canDeleteDocuments}
          userRole={user?.role ?? null}
          batchFileInputRef={batchFileInputRef}
          handleBatchUpload={(e) => void handleBatchUpload(e)}
          batchFiles={batchFiles}
          uploadStatus={uploadStatus}
          onDeleteDocument={(id) => void handleDeleteDocumentById(id)}
          workspaceMessage={workspaceMessage}
          documents={documents}
          documentsLoading={documentsLoading}
          queryDocumentScopeIds={queryDocumentScopeIds}
          toggleQueryDocumentScopeId={toggleQueryDocumentScopeId}
          clearQueryDocumentScope={clearQueryDocumentScope}
          providerVaults={providerVaults}
        />
      </div>
    </ErrorBoundary>
  );
}
