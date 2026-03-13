import type {
  OpenAiByokStatusResponse,
  QueryHistoryItem,
  QuerySseMetaEvent,
  WebSource,
} from "@/lib/contracts/api";
import type { Citation } from "@/lib/contracts/retrieval";
import type { Database } from "@/lib/supabase/database.types";
import type { AuthUser } from "@/lib/auth/types";
import type { ChangeEvent, RefObject } from "react";

export type Turn = {
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

export type UploadStatusSnapshot = {
  document: {
    id: string;
    title: string | null;
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

export type DocumentListItem = Pick<
  Database["public"]["Tables"]["documents"]["Row"],
  "id" | "title" | "status" | "created_at"
>;

export type ChatViewProps = {
  turns: Turn[];
  activeTurn: Turn | null;
  setActiveTurnId: (id: string) => void;
  downloadReport: (queryHistoryId: string, format: "docx" | "pdf") => void;
};

export type ChatInputProps = {
  query: string;
  setQuery: (q: string) => void;
  executeQuery: () => void;
  isStreaming: boolean;
  enableWebResearch: boolean;
  setEnableWebResearch: (v: boolean) => void;
  canQuery: boolean;
  effectiveQueryScopeId: string | null;
  onClearScope: () => void;
};

export type SidebarLeftProps = {
  documents: DocumentListItem[];
  documentsLoading: boolean;
  queryDocumentScopeId: string | null;
  setQueryDocumentScopeId: (id: string | null) => void;
  onDeleteDocument: (docId: string) => void;
  onRefreshDocuments: () => void;
  queryHistory: QueryHistoryItem[];
  historyLoading: boolean;
  onRefreshHistory: () => void;
  onRestoreHistory: (item: QueryHistoryItem) => void;
};

export type SidebarRightProps = {
  activeTurn: Turn | null;
  uploadFileInputRef: RefObject<HTMLInputElement | null>;
  handleUploadFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  uploadTitle: string;
  setUploadTitle: (v: string) => void;
  uploadLanguageHint: string;
  setUploadLanguageHint: (v: string) => void;
  handleUploadButtonClick: () => void;
  uploading: boolean;
  uploadFile: File | null;
  canUpload: boolean;
  userRole: string | null;
  effectiveQueryScopeId: string | null;
  batchFileInputRef: RefObject<HTMLInputElement | null>;
  handleBatchUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  batchFiles: Array<{ file: File; status: string; error?: string; documentId?: string }>;
  uploadStatus: UploadStatusSnapshot | null;
  onDeleteDocument: (docId: string) => void;
  workspaceMessage: string;
};

export type OpenAiKeyVaultProps = {
  user: AuthUser | null;
  openAiByokInput: string;
  setOpenAiByokInput: (v: string) => void;
  openAiByokStatus: OpenAiByokStatusResponse | null;
  openAiByokLoading: boolean;
  saveOpenAiByokKey: () => void;
  deleteOpenAiByokKey: () => void;
  loadOpenAiByokStatus: () => void;
};

export type DevSessionControlsProps = {
  token: string;
  setToken: (v: string) => void;
  createSession: () => void;
  clearSession: () => void;
};

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString();
}

export function getDocumentDisplayName(doc: { title: string | null; id: string }): string {
  return doc.title ?? doc.id.slice(0, 8);
}

export function getMessageToneClass(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("failed")) return "text-rose-600";
  if (lower.includes("ready") || lower.includes("complete")) return "text-teal-600";
  return "text-zinc-500";
}
