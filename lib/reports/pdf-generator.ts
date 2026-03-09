import PDFDocument from "pdfkit";
import type { ReportInput } from "./types";
import { COLORS as C, parseAnswerBlocks, formatReportDate } from "./report-styles";

/* ── layout constants ───────────────────────────────────── */
const MARGIN = 60;
const CONTENT_WIDTH_OFFSET = MARGIN * 2;
const FONT_TITLE = 22;
const FONT_HEADING = 14;
const FONT_BODY = 10.5;
const FONT_SMALL = 9;
const FONT_CAPTION = 8;
const LINE_GAP = 4;

export async function generatePdfReport(
  input: ReportInput,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margin: MARGIN,
      size: "A4",
      bufferPages: true,
      info: {
        Title: "RAG Query Report",
        Author: "RAG Knowledge Base",
        Subject: input.query.slice(0, 120),
        CreationDate: new Date(input.timestamp),
      },
    });

    const buffers: Uint8Array[] = [];
    doc.on("data", (chunk: Uint8Array) => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - CONTENT_WIDTH_OFFSET;
    const dateFormatted = formatReportDate(input.timestamp);

    /* ── helper: horizontal rule ────────────────────────── */
    function hr() {
      const yPos = doc.y;
      doc
        .strokeColor(C.border)
        .lineWidth(0.75)
        .moveTo(MARGIN, yPos)
        .lineTo(pageWidth - MARGIN, yPos)
        .stroke();
      doc.y = yPos + 12;
    }

    /* ── helper: section heading ────────────────────────── */
    function heading(text: string) {
      ensureSpace(50);
      doc.moveDown(0.8);
      doc
        .font("Helvetica-Bold")
        .fontSize(FONT_HEADING)
        .fillColor(C.primary)
        .text(text, MARGIN, undefined, { width: contentWidth });
      doc.moveDown(0.3);
      const lineY = doc.y;
      doc
        .strokeColor(C.accent)
        .lineWidth(2)
        .moveTo(MARGIN, lineY)
        .lineTo(MARGIN + 50, lineY)
        .stroke();
      doc.y = lineY + 10;
    }

    /* ── helper: ensure enough space on page ─────────────── */
    function ensureSpace(needed: number) {
      if (doc.y + needed > doc.page.height - MARGIN - 40) {
        doc.addPage();
      }
    }

    /* ── helper: body text ──────────────────────────────── */
    function bodyText(text: string, opts: { indent?: number; color?: string; italic?: boolean } = {}) {
      const indent = opts.indent ?? 0;
      const color = opts.color ?? C.body;
      const font = opts.italic ? "Helvetica-Oblique" : "Helvetica";

      doc
        .font(font)
        .fontSize(FONT_BODY)
        .fillColor(color)
        .text(text, MARGIN + indent, undefined, {
          width: contentWidth - indent,
          lineGap: LINE_GAP,
          paragraphGap: 4,
        });
    }

    /* ═══════════════════════════════════════════════════════
     *  TITLE BLOCK
     * ═══════════════════════════════════════════════════════ */
    doc.rect(0, 0, pageWidth, 6).fill(C.accent);
    doc.moveDown(2);

    doc
      .font("Helvetica-Bold")
      .fontSize(FONT_TITLE)
      .fillColor(C.primary)
      .text("QUERY REPORT", MARGIN, undefined, {
        width: contentWidth,
        align: "center",
        characterSpacing: 2,
      });

    doc.moveDown(0.2);

    doc
      .font("Helvetica-Oblique")
      .fontSize(FONT_BODY)
      .fillColor(C.muted)
      .text("RAG Knowledge Base", MARGIN, undefined, {
        width: contentWidth,
        align: "center",
      });

    doc.moveDown(0.3);

    doc
      .font("Helvetica")
      .fontSize(FONT_SMALL)
      .fillColor(C.muted)
      .text(dateFormatted, MARGIN, undefined, {
        width: contentWidth,
        align: "center",
      });

    doc.moveDown(1);
    hr();

    /* ═══════════════════════════════════════════════════════
     *  QUESTION
     * ═══════════════════════════════════════════════════════ */
    heading("Question");

    const qX = MARGIN + 8;
    const qWidth = contentWidth - 16;
    doc.font("Helvetica-Oblique").fontSize(FONT_BODY);
    const qTextHeight = doc.heightOfString(input.query, {
      width: qWidth - 16,
      lineGap: LINE_GAP,
    });
    const boxHeight = qTextHeight + 16;
    const boxY = doc.y;

    ensureSpace(boxHeight + 20);

    doc.roundedRect(qX, boxY, qWidth, boxHeight, 4).fill(C.light);

    doc
      .font("Helvetica-Oblique")
      .fontSize(FONT_BODY)
      .fillColor(C.body)
      .text(input.query, qX + 8, boxY + 8, {
        width: qWidth - 16,
        lineGap: LINE_GAP,
      });

    doc.y = boxY + boxHeight + 12;

    /* ═══════════════════════════════════════════════════════
     *  ANSWER
     * ═══════════════════════════════════════════════════════ */
    heading("Answer");

    for (const block of parseAnswerBlocks(input.answer)) {
      ensureSpace(30);

      switch (block.type) {
        case "bullet":
          doc
            .font("Helvetica")
            .fontSize(FONT_BODY)
            .fillColor(C.accent)
            .text("  •  ", MARGIN, undefined, { continued: true, width: contentWidth });
          doc.fillColor(C.body).text(block.content, { lineGap: LINE_GAP });
          doc.moveDown(0.2);
          break;

        case "numbered":
          doc
            .font("Helvetica-Bold")
            .fontSize(FONT_BODY)
            .fillColor(C.accent)
            .text(`  ${block.number}.  `, MARGIN, undefined, { continued: true, width: contentWidth });
          doc.font("Helvetica").fillColor(C.body).text(block.content, { lineGap: LINE_GAP });
          doc.moveDown(0.2);
          break;

        case "subheading":
          doc.moveDown(0.3);
          doc
            .font("Helvetica-Bold")
            .fontSize(FONT_BODY)
            .fillColor(C.accent)
            .text(block.content, MARGIN, undefined, { width: contentWidth, lineGap: LINE_GAP });
          doc.moveDown(0.2);
          break;

        case "body":
          bodyText(block.content);
          doc.moveDown(0.4);
          break;
      }
    }

    /* ═══════════════════════════════════════════════════════
     *  SOURCES & REFERENCES
     * ═══════════════════════════════════════════════════════ */
    if (input.chunks.length > 0) {
      doc.moveDown(0.5);
      hr();
      heading("Sources & References");

      doc
        .font("Helvetica-Oblique")
        .fontSize(FONT_SMALL)
        .fillColor(C.muted)
        .text(
          `${input.chunks.length} source${input.chunks.length === 1 ? "" : "s"} referenced in this report.`,
          MARGIN,
          undefined,
          { width: contentWidth },
        );
      doc.moveDown(0.6);

      for (let i = 0; i < input.chunks.length; i++) {
        const chunk = input.chunks[i];
        const docTitle =
          input.documentTitles[chunk.documentId] ?? "Unknown Document";
        const sectionLabel = chunk.sectionTitle
          ? ` — ${chunk.sectionTitle}`
          : "";
        const trimmedContent = chunk.content.trim();

        ensureSpace(60);

        // Source number badge + title
        doc
          .font("Helvetica-Bold")
          .fontSize(FONT_SMALL)
          .fillColor(C.accent)
          .text(`[${i + 1}]  `, MARGIN, undefined, { continued: true, width: contentWidth });
        doc
          .font("Helvetica-Bold")
          .fontSize(FONT_SMALL)
          .fillColor(C.primary)
          .text(docTitle, { continued: true });
        doc
          .font("Helvetica")
          .fillColor(C.muted)
          .text(`${sectionLabel}   p. ${chunk.pageNumber}`);

        doc.moveDown(0.2);

        // Source excerpt with left accent bar
        const excerptX = MARGIN + 20;
        const excerptWidth = contentWidth - 24;

        doc.font("Helvetica").fontSize(FONT_SMALL);
        const excerptHeight = doc.heightOfString(trimmedContent, {
          width: excerptWidth - 8,
          lineGap: 3,
        });

        ensureSpace(excerptHeight + 10);
        const barY = doc.y;

        doc
          .strokeColor(C.border)
          .lineWidth(2)
          .moveTo(excerptX, barY)
          .lineTo(excerptX, barY + excerptHeight + 4)
          .stroke();

        doc
          .font("Helvetica")
          .fontSize(FONT_SMALL)
          .fillColor(C.sourceContent)
          .text(trimmedContent, excerptX + 8, undefined, {
            width: excerptWidth - 8,
            lineGap: 3,
          });

        doc.moveDown(0.6);
      }
    }

    /* ═══════════════════════════════════════════════════════
     *  FOOTER DISCLAIMER
     * ═══════════════════════════════════════════════════════ */
    doc.moveDown(1);
    hr();
    doc
      .font("Helvetica-Oblique")
      .fontSize(FONT_CAPTION)
      .fillColor(C.muted)
      .text(
        "This report was generated from the RAG Knowledge Base. " +
          "Sources are extracted passages from ingested documents.",
        MARGIN,
        undefined,
        { width: contentWidth, align: "center" },
      );

    /* ── page numbers ───────────────────────────────────── */
    const totalPages = doc.bufferedPageRange().count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);
      doc
        .font("Helvetica")
        .fontSize(FONT_CAPTION)
        .fillColor(C.muted)
        .text(`Page ${i + 1} of ${totalPages}`, MARGIN, doc.page.height - 35, {
          width: contentWidth,
          align: "center",
        });
    }

    doc.end();
  });
}
