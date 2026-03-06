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
