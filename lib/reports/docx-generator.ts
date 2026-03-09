import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  TabStopType,
  TabStopPosition,
  Footer,
  PageNumber,
  ShadingType,
  convertInchesToTwip,
  type IParagraphOptions,
  type IRunOptions,
} from "docx";
import type { ReportInput } from "./types";
import { COLORS_DOCX as C, parseAnswerBlocks, formatReportDate } from "./report-styles";

/* ── reusable paragraph helpers ──────────────────────────── */
function spacer(pts = 120): Paragraph {
  return new Paragraph({ spacing: { after: pts } });
}

function horizontalRule(): Paragraph {
  return new Paragraph({
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 6, color: C.border },
    },
    spacing: { after: 200 },
  });
}

function styledRun(text: string, opts: Partial<IRunOptions> = {}): TextRun {
  return new TextRun({ text, font: "Calibri", ...opts });
}

function bodyParagraph(
  text: string,
  opts: Partial<IParagraphOptions> = {},
): Paragraph {
  return new Paragraph({
    spacing: { after: 120, line: 276 },
    ...opts,
    children: [styledRun(text, { size: 22 })],
  });
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 360, after: 160 },
    children: [styledRun(text, { size: 26, bold: true, color: C.primary })],
  });
}

/* ── render parsed answer blocks as DOCX paragraphs ──────── */
function renderAnswerBlocks(text: string): Paragraph[] {
  return parseAnswerBlocks(text).map((block) => {
    switch (block.type) {
      case "bullet":
        return new Paragraph({
          spacing: { after: 80, line: 276 },
          indent: { left: convertInchesToTwip(0.35) },
          bullet: { level: 0 },
          children: [styledRun(block.content, { size: 22 })],
        });

      case "numbered":
        return new Paragraph({
          spacing: { after: 80, line: 276 },
          indent: { left: convertInchesToTwip(0.35) },
          children: [
            styledRun(`${block.number}. `, { size: 22, bold: true }),
            styledRun(block.content, { size: 22 }),
          ],
        });

      case "subheading":
        return new Paragraph({
          spacing: { before: 200, after: 80, line: 276 },
          children: [
            styledRun(block.content, { size: 22, bold: true, color: C.accent }),
          ],
        });

      case "body":
        return bodyParagraph(block.content);
    }
  });
}

/* ── main generator ──────────────────────────────────────── */
export async function generateDocxReport(
  input: ReportInput,
): Promise<Buffer> {
  const dateFormatted = formatReportDate(input.timestamp);
  const children: Paragraph[] = [];

  /* ── title block ──────────────────────────────────────── */
  children.push(spacer(400));

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [
        styledRun("QUERY REPORT", {
          size: 36,
          bold: true,
          color: C.primary,
          characterSpacing: 120,
        }),
      ],
    }),
  );

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [
        styledRun("RAG Knowledge Base", {
          size: 22,
          color: C.muted,
          italics: true,
        }),
      ],
    }),
  );

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
      children: [
        styledRun(dateFormatted, { size: 20, color: C.muted }),
      ],
    }),
  );

  children.push(horizontalRule());

  /* ── query section ────────────────────────────────────── */
  children.push(sectionHeading("Question"));
  children.push(
    new Paragraph({
      spacing: { after: 200, line: 276 },
      shading: { type: ShadingType.SOLID, color: C.light },
      indent: {
        left: convertInchesToTwip(0.2),
        right: convertInchesToTwip(0.2),
      },
      children: [
        styledRun(input.query, { size: 22, italics: true }),
      ],
    }),
  );

  /* ── answer section ───────────────────────────────────── */
  children.push(sectionHeading("Answer"));
  children.push(...renderAnswerBlocks(input.answer));

  /* ── sources section ──────────────────────────────────── */
  if (input.chunks.length > 0) {
    children.push(spacer(200));
    children.push(horizontalRule());
    children.push(sectionHeading("Sources & References"));

    children.push(
      new Paragraph({
        spacing: { after: 160 },
        children: [
          styledRun(
            `${input.chunks.length} source${input.chunks.length === 1 ? "" : "s"} referenced in this report.`,
            { size: 20, color: C.muted, italics: true },
          ),
        ],
      }),
    );

    for (let i = 0; i < input.chunks.length; i++) {
      const chunk = input.chunks[i];
      const docTitle =
        input.documentTitles[chunk.documentId] ?? "Unknown Document";
      const sectionLabel = chunk.sectionTitle ? ` — ${chunk.sectionTitle}` : "";

      children.push(
        new Paragraph({
          spacing: { before: 200, after: 60 },
          border: {
            bottom: {
              style: BorderStyle.SINGLE,
              size: 2,
              color: C.light,
            },
          },
          tabStops: [
            { type: TabStopType.RIGHT, position: TabStopPosition.MAX },
          ],
          children: [
            styledRun(`[${i + 1}]  `, {
              size: 20,
              bold: true,
              color: C.accent,
            }),
            styledRun(docTitle, { size: 20, bold: true }),
            styledRun(sectionLabel, { size: 20, color: C.muted }),
            styledRun(`\tp. ${chunk.pageNumber}`, {
              size: 18,
              color: C.muted,
            }),
          ],
        }),
      );

      children.push(
        new Paragraph({
          spacing: { after: 160, line: 260 },
          indent: { left: convertInchesToTwip(0.3) },
          children: [
            styledRun(chunk.content.trim(), { size: 20, color: C.sourceContent }),
          ],
        }),
      );
    }
  }

  /* ── footer disclaimer ────────────────────────────────── */
  children.push(spacer(300));
  children.push(horizontalRule());
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [
        styledRun(
          "This report was generated from the RAG Knowledge Base. " +
            "Sources are extracted passages from ingested documents.",
          { size: 16, color: C.muted, italics: true },
        ),
      ],
    }),
  );

  /* ── assemble document ────────────────────────────────── */
  const doc = new Document({
    title: "RAG Query Report",
    description: `Report generated ${dateFormatted}`,
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22 },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              bottom: convertInchesToTwip(0.8),
              left: convertInchesToTwip(1.1),
              right: convertInchesToTwip(1.1),
            },
            pageNumbers: { start: 1 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  styledRun("Page ", { size: 16, color: C.muted }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font: "Calibri",
                    size: 16,
                    color: C.muted,
                  }),
                  styledRun(" of ", { size: 16, color: C.muted }),
                  new TextRun({
                    children: [PageNumber.TOTAL_PAGES],
                    font: "Calibri",
                    size: 16,
                    color: C.muted,
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}
