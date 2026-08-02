// What this app tells the Kommandozentrale it can do (dashboard F2.2/F2.4).
//
// Two capabilities, because the RAG system is two things to the dashboard: a
// place to ask questions of the corpus, and a place to put a document into it.

import { z } from "zod";

export const APP_ID = "rag-system";

/** The inputs a dashboard-triggered question accepts. */
export const askInputSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("Die Frage an den Dokumentenbestand."),
  topK: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe(
      "Wie viele Textstellen herangezogen werden. Standard: die des Systems.",
    ),
  enableWebResearch: z
    .boolean()
    .optional()
    .describe(
      "Zusätzlich das Web befragen, wenn die Dokumente nicht ausreichen.",
    ),
  clientRef: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "Eigene ID des Aufrufers. Ein Wiederholungsversuch mit derselben ID " +
        "liefert dieselbe Lieferung, statt erneut zu antworten.",
    ),
});

export type AskInput = z.infer<typeof askInputSchema>;

export function manifest() {
  return {
    app: APP_ID,
    name: "RAG System",
    description:
      "Beantwortet Fragen aus dem eigenen Dokumentenbestand, mit Quellenangabe. " +
      "Nimmt neue PDFs entgegen und indexiert sie.",
    version: 1,
    languages: ["de", "en", "fr", "it", "es"],
    capabilities: [
      {
        id: "answer",
        label: "Frage an die Dokumente",
        resultKind: "answer",
        estimate: "5–30 s",
      },
      {
        id: "document",
        label: "PDF aufnehmen",
        // Not a result kind: an upload produces an indexed document, not a
        // delivery. The dashboard polls its status instead of waiting for one.
        resultKind: null,
        estimate: "Aufnahme sofort · Indexierung 1–5 min",
        upload: { accept: "application/pdf", maxBytes: 25 * 1024 * 1024 },
      },
    ],
    input: z.toJSONSchema(askInputSchema, { io: "input" }),
  };
}
