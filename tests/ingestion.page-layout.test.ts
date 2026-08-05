import assert from "node:assert/strict";
import test from "node:test";

import {
  assemblePage,
  type PageTextItem,
} from "@/lib/ingestion/runtime/page-layout";

/**
 * Builds an item with a width derived from a fixed 6pt glyph advance, so the
 * fixtures read as coordinates rather than as arithmetic.
 */
function item(text: string, x: number, y: number, advance = 6): PageTextItem {
  return { text, x, y, width: text.length * advance };
}

test("assemblePage reconstructs a three-column table emitted cell-major", () => {
  // The shape pdfjs actually produces for AI_Change_Management.pdf p14: each
  // wrapped cell is finished before the next column starts, so y runs
  // 288 -> 271 -> 288 -> 271 -> 288 rather than left to right.
  const page = assemblePage([
    item("Herausforderung", 91, 323),
    item("Problem", 197, 323),
    item("Lösung", 553, 323),
    item("Output-", 91, 288),
    item("Konsistenz", 91, 271),
    item("Verschiedene PDFs ergaben", 198, 288),
    item("strukturierte Abstracts", 198, 271),
    item("Zwei-Schritt-Prozess", 554, 288),
    item("Tone of Voice", 91, 234),
    item("Wie klingt Caritas?", 198, 234),
    item("Strukturiertes Feedback", 554, 234),
  ]);

  assert.equal(page.hasTables, true);
  assert.match(page.text, /^\| Herausforderung \| Problem \| Lösung \|$/m);
  assert.match(page.text, /^\| --- \| --- \| --- \|$/m);
  // The wrapped first cell rejoins across the hyphen, and its row keeps all
  // three columns associated.
  assert.match(
    page.text,
    /^\| Output-Konsistenz \| Verschiedene PDFs ergaben strukturierte Abstracts \| Zwei-Schritt-Prozess \|$/m,
  );
});

test("assemblePage pulls a blank-cornered comparison header into the table", () => {
  const page = assemblePage([
    item("Example 1", 200, 300),
    item("Example 2", 400, 300),
    item("Zufriedenheit", 60, 270),
    item("Gering", 200, 270),
    item("Hoch", 400, 270),
    item("Modell", 60, 240),
    item("Anderes Setup", 200, 240),
    item("Claude Sonnet", 400, 240),
    item("Fazit", 60, 210),
    item("Nicht donor-ready", 200, 210),
    item("Benchmark", 400, 210),
  ]);

  assert.equal(page.hasTables, true);
  // Blank top-left corner preserved; the first data row is not promoted.
  assert.match(page.text, /^\|\s+\| Example 1 \| Example 2 \|$/m);
  assert.match(page.text, /^\| Zufriedenheit \| Gering \| Hoch \|$/m);
});

test("assemblePage leaves a checklist alone rather than reading it as a table", () => {
  // Checkliste_Handbuch_DZ.pdf: a checkbox glyph sits far enough left to look
  // like a column, on every line, for fifty pages.
  const page = assemblePage([
    item("☐", 91, 300, 10),
    item("Erstellen Sie eine E-Mail", 122, 300),
    item("☐", 91, 280, 10),
    item("Wenn die Person nicht versichert ist", 122, 280),
    item("☐", 91, 260, 10),
    item("Bestätigen Sie das Vorhandensein", 122, 260),
  ]);

  assert.equal(page.hasTables, false);
  assert.equal(
    page.text,
    [
      "☐ Erstellen Sie eine E-Mail",
      "☐ Wenn die Person nicht versichert ist",
      "☐ Bestätigen Sie das Vorhandensein",
    ].join("\n"),
  );
});

test("assemblePage does not interleave side-by-side text boxes", () => {
  // Rollen-Basierte-Arbeit-Redesign.pdf p6: three parallel boxes share
  // baselines. Grouping by baseline would merge them into one line of
  // nonsense, so a page with no table must come out exactly as before.
  const page = assemblePage([
    item("Unklare Verantwortlichkeiten:", 60, 300),
    item("Ist das meine Aufgabe?", 60, 280),
    item("Bottlenecks durch Personen-", 260, 300),
    item("Abhängigkeit", 260, 280),
    item("Wissen geht verloren", 460, 300),
    item("Krankheit, Kündigungen", 460, 280),
  ]);

  assert.equal(page.hasTables, false);
  assert.equal(
    page.text,
    [
      "Unklare Verantwortlichkeiten:",
      "Ist das meine Aufgabe?",
      "Bottlenecks durch Personen-",
      "Abhängigkeit",
      "Wissen geht verloren",
      "Krankheit, Kündigungen",
    ].join("\n"),
  );
});

test("assemblePage does not turn a two-field labelled line into a table", () => {
  // 20240819_Projektbeschreibungen: a form, not a table. Three cells on one
  // line are not enough — a table needs three aligned rows.
  const page = assemblePage([
    item("Start:", 60, 300),
    item("01.04.2024", 138, 300),
    item("Projektkategorie:", 329, 300),
    item("Ende:", 60, 280),
    item("30.6.2026", 138, 280),
  ]);

  assert.equal(page.hasTables, false);
  assert.match(page.text, /Start: 01\.04\.2024 Projektkategorie:/);
});

test("assemblePage keeps the previous output when items carry no width", () => {
  // Injected fixtures and the byte-scrape fallback have no width information;
  // there is nothing to reason about spacing with.
  const page = assemblePage([
    { text: "First line", x: 0, y: 300, width: 0 },
    { text: "Second line", x: 0, y: 280, width: 0 },
  ]);

  assert.equal(page.hasTables, false);
  assert.equal(page.text, "First line\nSecond line");
});

test("assemblePage separates rows by line spacing, not just cell count", () => {
  // Every column wraps, so cell count cannot tell a wrapped line from a new
  // record. The tight baseline gap inside a record does.
  const page = assemblePage([
    item("Absatz", 60, 400),
    item("Inhalt", 200, 400),
    item("Guidance", 400, 400),
    item("1 Context &", 60, 360),
    item("Problem, Ort,", 200, 360),
    item("Start with a hook", 400, 360),
    item("Challenge", 60, 344),
    item("Dringlichkeit", 200, 344),
    item("grounds the reader", 400, 344),
    item("2 Intervention", 60, 304),
    item("Lösung, Ansatz", 200, 304),
    item("Confident, clear", 400, 304),
  ]);

  assert.equal(page.hasTables, true);
  assert.match(
    page.text,
    /^\| 1 Context & Challenge \| Problem, Ort, Dringlichkeit \| Start with a hook grounds the reader \|$/m,
  );
  assert.match(
    page.text,
    /^\| 2 Intervention \| Lösung, Ansatz \| Confident, clear \|$/m,
  );
});

test("assemblePage escapes pipes inside reconstructed cells", () => {
  const page = assemblePage([
    item("A", 60, 300),
    item("B", 200, 300),
    item("C", 400, 300),
    item("x|y", 60, 280),
    item("q", 200, 280),
    item("r", 400, 280),
    item("s", 60, 260),
    item("t", 200, 260),
    item("u", 400, 260),
  ]);

  assert.equal(page.hasTables, true);
  assert.match(page.text, /\| x\\\|y \|/);
});
