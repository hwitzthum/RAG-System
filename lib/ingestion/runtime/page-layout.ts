/**
 * Layout-aware assembly of a PDF page's text items into text.
 *
 * The previous assembler read only `transform[5]` — the y component — broke a
 * line whenever y moved by more than 2 *in emission order*, and joined
 * everything on a baseline with a single space. A table row's cells therefore
 * became `Cell A Cell B Cell C` with no delimiter and no header association,
 * so a number could no longer be attributed to its row or column label.
 *
 * Worse, pdfjs emits table content **cell-major**, not row-major: on
 * `AI_Change_Management.pdf` p14 the y sequence runs 288.3 → 271.7 → 288.3 →
 * 271.7 → 288.3 as the generator finishes each wrapped cell before starting
 * the next column. Breaking on y *in emission order* therefore shattered every
 * row into one fragment per cell line.
 *
 * Regrouping items by baseline repairs that. It is also dangerous: on any page
 * with side-by-side content the left and right blocks share baselines, and
 * grouping by y interleaves them into nonsense. Both failures were measured on
 * this corpus — a two-column paper and a three-box slide — so the regrouping is
 * scoped as tightly as possible:
 *
 *   **A page is emitted exactly as the previous assembler emitted it, except
 *   that a run of lines proven to be a table is replaced by a Markdown table.**
 *
 * Nothing is reordered, and a page with no table is byte-identical to before.
 * The consequence is that genuine multi-column *reordering* is not implemented;
 * see `docs/RAG_QUALITY_IMPROVEMENT_PLAN.md` item 2.3 for why that half was
 * withdrawn on measurement rather than shipped untested.
 */

export type PageTextItem = {
  text: string;
  x: number;
  y: number;
  width: number;
};

export type AssembledPage = {
  text: string;
  hasTables: boolean;
};

/** Baseline tolerance, carried over from the previous assembler. */
const Y_TOLERANCE = 2;
/**
 * A horizontal gap wider than this many *local* glyph advances separates two
 * cells. Word spaces live inside an item's own string, so any gap between two
 * items is already deliberate; 2 distinguishes a font-change seam (~0.5
 * advances) from a column gutter (~2.5 advances and up).
 */
const CELL_GAP_FACTOR = 2;
/** Two cells within this many advances belong to the same grid column. */
const COLUMN_MATCH_FACTOR = 1.5;
/** A table needs at least this many full-width rows, header included. */
const MIN_TABLE_ROWS = 3;
/** A pipe table needs at least this many columns; fewer is a labelled field. */
const MIN_TABLE_COLUMNS = 3;

type IndexedItem = PageTextItem & { index: number };

type Cell = {
  x: number;
  end: number;
  text: string;
  items: IndexedItem[];
};

type LegacyLine = {
  text: string;
  itemIndexes: number[];
};

type TableRegion = {
  markdown: string;
  itemIndexes: Set<number>;
};

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Median width of one glyph on the page, used only as a per-item fallback. */
function pageGlyphAdvance(items: PageTextItem[]): number {
  return median(
    items
      .filter((item) => item.width > 0 && item.text.length > 0)
      .map((item) => item.width / item.text.length),
  );
}

/** Width of one glyph in this item, falling back to the page median. */
function itemAdvance(item: PageTextItem, pageAdvance: number): number {
  if (item.width > 0 && item.text.length > 0) {
    return item.width / item.text.length;
  }
  return pageAdvance;
}

/**
 * The previous assembler, reproduced exactly, but recording which items landed
 * on each line so a table region can be spliced back over them.
 */
function buildLegacyLines(items: IndexedItem[]): LegacyLine[] {
  const lines: LegacyLine[] = [];
  let current: IndexedItem[] = [];
  let lastY: number | null = null;

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    lines.push({
      text: current
        .map((item) => item.text)
        .join(" ")
        .replace(/[ \t]+/g, " ")
        .trim(),
      itemIndexes: current.map((item) => item.index),
    });
    current = [];
  };

  for (const item of items) {
    if (lastY !== null && Math.abs(item.y - lastY) > Y_TOLERANCE) {
      flush();
    }
    current.push(item);
    lastY = item.y;
  }
  flush();

  return lines;
}

/** Groups items into visual rows by baseline, ignoring emission order. */
function groupByBaseline(items: IndexedItem[]): IndexedItem[][] {
  const byBaseline = [...items].sort((a, b) => b.y - a.y);
  const rows: IndexedItem[][] = [];
  let currentY: number | null = null;

  for (const item of byBaseline) {
    if (currentY !== null && Math.abs(currentY - item.y) <= Y_TOLERANCE) {
      rows[rows.length - 1]!.push(item);
      continue;
    }
    rows.push([item]);
    currentY = item.y;
  }

  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
  }
  return rows;
}

/**
 * A leading glyph that marks a list item rather than occupying a column —
 * `☐`, `•`, `-`, and the replacement characters this corpus's checklists use.
 * Without this guard `Checkliste_Handbuch_DZ.pdf` reads as 34.5% tables.
 */
function isMarker(text: string): boolean {
  return text.length <= 2 && !/[\p{L}\p{N}]/u.test(text);
}

/**
 * Splits a baseline into cells on horizontal gaps, then absorbs list markers.
 *
 * The gap threshold scales with the *neighbouring* glyphs rather than the page
 * median: a page median is dragged upwards by heading text (a 34-character
 * slide title at ~18pt/glyph against ~6pt body text), and the inflated
 * threshold then swallows a genuine 15pt column gutter as if it were a space.
 */
function splitIntoCells(row: IndexedItem[], pageAdvance: number): Cell[] {
  const cells: Cell[] = [];
  let previous: IndexedItem | null = null;

  for (const item of row) {
    const localAdvance = previous
      ? Math.min(
          itemAdvance(previous, pageAdvance),
          itemAdvance(item, pageAdvance),
        )
      : itemAdvance(item, pageAdvance);
    previous = item;

    const current = cells[cells.length - 1];
    if (current && item.x - current.end <= CELL_GAP_FACTOR * localAdvance) {
      current.text = `${current.text} ${item.text}`;
      current.end = Math.max(current.end, item.x + item.width);
      current.items.push(item);
      continue;
    }

    cells.push({
      x: item.x,
      end: item.x + item.width,
      text: item.text,
      items: [item],
    });
  }

  while (cells.length >= 2 && isMarker(cells[0]!.text.trim())) {
    const marker = cells.shift()!;
    const next = cells[0]!;
    next.text = `${marker.text} ${next.text}`;
    next.x = marker.x;
    next.items.unshift(...marker.items);
  }

  for (const cell of cells) {
    cell.text = cell.text.replace(/[ \t]+/g, " ").trim();
  }
  return cells;
}

/**
 * Clusters cell left edges into a column grid, comparing each position against
 * the *cluster centroid* rather than its predecessor. Chaining against the
 * predecessor lets a column drift indefinitely — near-adjacent edges produced
 * 22 spurious columns for one row of a four-column table.
 */
function buildColumnGrid(rows: Cell[][], advance: number): number[] {
  const positions = rows
    .flat()
    .map((cell) => cell.x)
    .sort((a, b) => a - b);

  const threshold = COLUMN_MATCH_FACTOR * advance;
  const clusters: number[][] = [];

  for (const position of positions) {
    const current = clusters[clusters.length - 1];
    if (current) {
      const centroid =
        current.reduce((sum, value) => sum + value, 0) / current.length;
      if (position - centroid <= threshold) {
        current.push(position);
        continue;
      }
    }
    clusters.push([position]);
  }

  return clusters.map(
    (cluster) =>
      cluster.reduce((sum, value) => sum + value, 0) / cluster.length,
  );
}

function columnIndex(x: number, grid: number[], advance: number): number {
  const threshold = COLUMN_MATCH_FACTOR * advance;
  for (let index = 0; index < grid.length; index += 1) {
    if (Math.abs(grid[index]! - x) <= threshold) {
      return index;
    }
  }
  return -1;
}

function matchesGrid(cells: Cell[], grid: number[], advance: number): boolean {
  return cells.every((cell) => columnIndex(cell.x, grid, advance) >= 0);
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/**
 * Threshold below which a baseline gap means "same record".
 *
 * Within a table record, wrapped lines sit one leading apart (~17pt on this
 * corpus); separate records sit a paragraph apart (~37pt). Cell count alone
 * cannot tell them apart when every column happens to wrap, so the spacing
 * decides. Returns null when the gaps are uniform — a table of single-line
 * rows — in which case cell count is the only signal and the caller falls back
 * to it.
 */
function continuationGapThreshold(baselineYs: number[]): number | null {
  const gaps: number[] = [];
  for (let index = 1; index < baselineYs.length; index += 1) {
    gaps.push(Math.abs(baselineYs[index - 1]! - baselineYs[index]!));
  }
  if (gaps.length < 2) {
    return null;
  }

  const smallest = Math.min(...gaps);
  const largest = Math.max(...gaps);
  if (smallest <= 0 || largest / smallest < 1.5) {
    return null;
  }
  return (smallest + largest) / 2;
}

/**
 * Renders a run of baselines as a Markdown pipe table. Wrapped continuations —
 * pdfjs emits a wrapped cell as its own baseline — are folded into the row
 * above, per column.
 */
function renderTable(
  rows: Cell[][],
  baselineYs: number[],
  grid: number[],
  advance: number,
): string {
  const merged: string[][] = [];
  const gapThreshold = continuationGapThreshold(baselineYs);

  for (const [position, cells] of rows.entries()) {
    const row = new Array<string>(grid.length).fill("");
    for (const cell of cells) {
      const index = columnIndex(cell.x, grid, advance);
      if (index >= 0) {
        row[index] = cell.text;
      }
    }

    const gapToPrevious =
      position > 0
        ? Math.abs(baselineYs[position - 1]! - baselineYs[position]!)
        : Infinity;
    const isContinuation =
      cells.length < grid.length ||
      (gapThreshold !== null && gapToPrevious < gapThreshold);

    const previous = merged[merged.length - 1];
    if (previous !== undefined && isContinuation) {
      for (let index = 0; index < grid.length; index += 1) {
        const addition = row[index]!;
        if (!addition) {
          continue;
        }
        const existing = previous[index]!;
        if (!existing) {
          previous[index] = addition;
        } else if (existing.endsWith("-")) {
          // A hyphen at the wrap point is a broken word, not a list dash.
          previous[index] = `${existing}${addition}`;
        } else {
          previous[index] = `${existing} ${addition}`;
        }
      }
      continue;
    }

    merged.push(row);
  }

  const body = merged.map(
    (row) => `| ${row.map((cell) => escapeCell(cell)).join(" | ")} |`,
  );
  const separator = `| ${grid.map(() => "---").join(" | ")} |`;
  return [body[0]!, separator, ...body.slice(1)].join("\n");
}

/**
 * Finds runs of baselines that form a table. The seed row alone defines the
 * grid — anchoring on the whole page instead lets a labelled form (`Start: |
 * 01.04.2024 | Projektkategorie: …`) bridge into a table with the unrelated
 * lines around it.
 */
function findTableRegions(
  baselineRows: IndexedItem[][],
  advance: number,
): TableRegion[] {
  const cellRows = baselineRows.map((row) => splitIntoCells(row, advance));
  const baselineYs = baselineRows.map((row) => row[0]?.y ?? 0);
  const regions: TableRegion[] = [];
  let index = 0;

  while (index < cellRows.length) {
    if (cellRows[index]!.length < MIN_TABLE_COLUMNS) {
      index += 1;
      continue;
    }

    const grid = buildColumnGrid([cellRows[index]!], advance);
    const rows: Cell[][] = [cellRows[index]!];
    const ys: number[] = [baselineYs[index]!];
    let fullRows = 1;
    let pending: Cell[][] = [];
    let pendingYs: number[] = [];
    let cursor = index + 1;

    while (cursor < cellRows.length) {
      const cells = cellRows[cursor]!;
      if (cells.length === 0 || !matchesGrid(cells, grid, advance)) {
        break;
      }
      if (cells.length === grid.length) {
        rows.push(...pending, cells);
        ys.push(...pendingYs, baselineYs[cursor]!);
        pending = [];
        pendingYs = [];
        fullRows += 1;
      } else {
        // Held back until a real row follows, so trailing prose that happens
        // to align is not swallowed into the table.
        pending.push(cells);
        pendingYs.push(baselineYs[cursor]!);
      }
      cursor += 1;
    }

    if (fullRows >= MIN_TABLE_ROWS) {
      // Trailing continuations belong to the last row.
      rows.push(...pending);
      ys.push(...pendingYs);

      /*
       * A comparison table has a blank top-left corner, so its header carries
       * fewer cells than the grid and cannot seed a region. Without this the
       * column labels are stranded above the table and the first data row is
       * promoted to header — actively misleading, where the old flat text was
       * merely unstructured. Reach back exactly one baseline for a line whose
       * cells all land on the grid.
       */
      const above = index - 1;
      if (
        above >= 0 &&
        cellRows[above]!.length >= 2 &&
        cellRows[above]!.length < grid.length &&
        matchesGrid(cellRows[above]!, grid, advance)
      ) {
        rows.unshift(cellRows[above]!);
        ys.unshift(baselineYs[above]!);
        index = above;
      }

      regions.push({
        markdown: renderTable(rows, ys, grid, advance),
        itemIndexes: new Set(
          rows.flatMap((cells) =>
            cells.flatMap((cell) => cell.items.map((item) => item.index)),
          ),
        ),
      });
      index += rows.length;
      continue;
    }

    index += 1;
  }

  return regions;
}

export function assemblePage(items: PageTextItem[]): AssembledPage {
  const usable: IndexedItem[] = items
    .filter((item) => item.text.trim().length > 0)
    .map((item, index) => ({ ...item, index }));

  if (usable.length === 0) {
    return { text: "", hasTables: false };
  }

  const legacyLines = buildLegacyLines(usable);
  const advance = pageGlyphAdvance(usable);
  if (advance <= 0) {
    // No width information (injected fixtures, exotic generators): there is
    // nothing to reason about spacing with, so keep the previous behaviour.
    return {
      text: legacyLines
        .map((line) => line.text)
        .join("\n")
        .trim(),
      hasTables: false,
    };
  }

  const regions = findTableRegions(groupByBaseline(usable), advance);

  /*
   * Splice each table over the legacy lines its items came from. A region is
   * only applied when it covers a *contiguous* span of legacy lines and covers
   * them *completely* — otherwise substituting it would drop or duplicate text
   * that merely shared a baseline with the table.
   */
  const replacements = new Map<number, string>();
  const removed = new Set<number>();

  for (const region of regions) {
    const covered: number[] = [];
    for (let line = 0; line < legacyLines.length; line += 1) {
      const indexes = legacyLines[line]!.itemIndexes;
      if (indexes.some((index) => region.itemIndexes.has(index))) {
        covered.push(line);
      }
    }

    if (covered.length === 0) {
      continue;
    }

    const contiguous =
      covered[covered.length - 1]! - covered[0]! === covered.length - 1;
    const complete = covered.every((line) =>
      legacyLines[line]!.itemIndexes.every((index) =>
        region.itemIndexes.has(index),
      ),
    );
    const free = covered.every((line) => !removed.has(line));

    if (!contiguous || !complete || !free) {
      continue;
    }

    replacements.set(covered[0]!, region.markdown);
    for (const line of covered) {
      removed.add(line);
    }
  }

  const output: string[] = [];
  for (let line = 0; line < legacyLines.length; line += 1) {
    const replacement = replacements.get(line);
    if (replacement !== undefined) {
      output.push(replacement);
      continue;
    }
    if (removed.has(line)) {
      continue;
    }
    output.push(legacyLines[line]!.text);
  }

  return {
    text: output
      .filter((line) => line.length > 0)
      .join("\n")
      .trim(),
    hasTables: replacements.size > 0,
  };
}
