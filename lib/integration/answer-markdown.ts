// The answer as a file (dashboard F2.4).
//
// Deliberately free of imports: a delivery's text is built from data the caller
// already has, so a test — or anything else — can render one without a Supabase
// client, an env contract, or a network.

export type AnswerSource = {
  documentId: string;
  title: string;
  pages: number[];
};

/** The sources as a small file, so the delivery stands on its own in the feed. */
export function sourcesToMarkdown(
  question: string,
  answer: string,
  sources: AnswerSource[],
): string {
  const lines = [`# ${question}`, "", answer.trim(), ""];

  if (sources.length > 0) {
    lines.push("## Quellen", "");
    for (const source of sources) {
      const pages =
        source.pages.length === 1
          ? `S. ${source.pages[0]}`
          : `S. ${source.pages.join(", ")}`;
      lines.push(`- ${source.title} — ${pages}`);
    }
  } else {
    lines.push(
      "## Quellen",
      "",
      "_Keine — die Antwort stützt sich auf keine Textstelle im Bestand._",
    );
  }

  return `${lines.join("\n")}\n`;
}
