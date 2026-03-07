import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import type { ReportInput } from "./types";

export async function generateDocxReport(input: ReportInput): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      text: "RAG Query Report",
      heading: HeadingLevel.HEADING_1,
    }),
    new Paragraph({
      children: [new TextRun({ text: `Generated: ${input.timestamp}`, italics: true })],
    }),
    new Paragraph({ text: "" }),
    new Paragraph({ text: "Query", heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ text: input.query }),
    new Paragraph({ text: "" }),
    new Paragraph({ text: "Answer", heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ text: input.answer }),
  ];

  if (input.chunks.length > 0) {
    children.push(new Paragraph({ text: "" }));
    children.push(new Paragraph({ text: "Sources", heading: HeadingLevel.HEADING_2 }));

    for (const chunk of input.chunks) {
      const docTitle = input.documentTitles[chunk.documentId] ?? "Unknown";
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${docTitle} (p. ${chunk.pageNumber})`, bold: true }),
          ],
        }),
      );
      children.push(new Paragraph({ text: chunk.content }));
      children.push(new Paragraph({ text: "" }));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  return Buffer.from(buffer);
}