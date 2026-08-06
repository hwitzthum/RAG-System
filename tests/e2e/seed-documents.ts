import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { getTestAdminClient } from "./auth-states";

/**
 * Seeds a shared, ready document.
 *
 * `user_id: null` makes it visible to any reader (see `listAccessibleDocumentIds`),
 * and `status: "ready"` is required for it to appear in the document list.
 */
export async function seedReadyDocument(title: string): Promise<string> {
  const supabase = getTestAdminClient();
  const id = randomUUID();
  const { error } = await supabase.from("documents").insert({
    id,
    user_id: null,
    storage_path: `e2e-layout/${id}.pdf`,
    sha256: randomUUID().replace(/-/g, "").repeat(2).slice(0, 64),
    title,
    status: "ready",
  });
  expect(error).toBeNull();
  return id;
}

export async function deleteSeededDocuments(
  documentIds: string[],
): Promise<void> {
  if (documentIds.length === 0) return;
  const supabase = getTestAdminClient();
  await supabase.from("documents").delete().in("id", documentIds);
}

/**
 * A title long enough to force the failure mode under test. Real corpora carry
 * names like `20240819_Projektbeschreibungen_Gesamtprojekt_final.pdf`, and it
 * was exactly such a name that widened a grid column past its rail.
 */
export function longDocumentTitle(suffix: string): string {
  return `20240819_Projektbeschreibungen_Gesamtprojekt_Abschlussbericht_${suffix}.pdf`;
}
