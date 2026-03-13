import type { SupportedLanguage } from "@/lib/contracts/retrieval";

export function buildIdempotencyKey(checksumSha256: string, ingestionVersion: number): string {
  return `${checksumSha256}:v${ingestionVersion}`;
}

function sanitizeFileName(fileName: string): string {
  const strippedExt = fileName.replace(/\.pdf$/i, "");
  const normalized = strippedExt.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  if (!normalized) {
    return "document";
  }

  return normalized.slice(0, 48);
}

export function buildStoragePath(checksumSha256: string, fileName: string): string {
  const safeName = sanitizeFileName(fileName);
  return `uploads/${checksumSha256}-${safeName}.pdf`;
}

export function looksLikePdfUpload(fileName: string, mimeType: string): boolean {
  return (
    mimeType === "application/pdf" ||
    fileName.toLowerCase().endsWith(".pdf")
  );
}

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

export function hasPdfSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  return PDF_MAGIC.every((b, i) => bytes[i] === b);
}

export function normalizeLanguageHint(value: string | null | undefined): SupportedLanguage | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  if (normalized === "EN" || normalized === "DE" || normalized === "FR" || normalized === "IT" || normalized === "ES") {
    return normalized;
  }

  return null;
}
