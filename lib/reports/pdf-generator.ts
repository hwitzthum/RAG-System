import PDFDocument from "pdfkit";
import type { ReportInput } from "./types";

export async function generatePdfReport(input: ReportInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const buffers: Uint8Array[] = [];

    doc.on("data", (chunk: Uint8Array) => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    doc.fontSize(20).text("RAG Query Report", { align: "center" });
    doc.moveDown();
    doc.fontSize(10).text(`Generated: ${input.timestamp}`, { align: "center" });
    doc.moveDown(2);

    doc.fontSize(14).text("Query");
    doc.moveDown(0.5);
    doc.fontSize(11).text(input.query);
    doc.moveDown();

    doc.fontSize(14).text("Answer");
    doc.moveDown(0.5);
    doc.fontSize(11).text(input.answer);
    doc.moveDown();

    if (input.chunks.length > 0) {
      doc.fontSize(14).text("Sources");
      doc.moveDown(0.5);

      for (const chunk of input.chunks) {
        const docTitle = input.documentTitles[chunk.documentId] ?? "Unknown";
        doc.fontSize(11).text(`${docTitle} (p. ${chunk.pageNumber})`, { underline: true });
        doc.fontSize(10).text(chunk.content);
        doc.moveDown(0.5);
      }
    }

    doc.end();
  });
}