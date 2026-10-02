/**
 * Column widths for data grids, worked out from the data rather than
 * shared evenly.
 *
 * react-data-grid can size a column to its content (`width: "max-content"`),
 * but it measures that once, from whatever rows are rendered at the time --
 * often none yet, since the grid renders before its data loads -- and never
 * again when the content changes. Instead, each column describes how narrow
 * it may get and how wide its content wants to be (`sizeColumn`), and
 * `allocateColumnWidths` shares the grid's width out: every column gets its
 * minimum, columns with data grow toward fitting their content, and anything
 * left over is split equally between them.
 */

/** Measures `text` in the grid's font, in CSS pixels. */
export type MeasureText = (text: string, options: { bold: boolean }) => number;

export interface ColumnSizing {
  /** Narrowest the column may get; below this the grid scrolls sideways. */
  min: number;
  /** Width that shows the column's widest value in full. */
  ideal: number;
  /** Whether any row has a value here; only these columns grow. */
  hasData: boolean;
}

export const ELLIPSIS = "…";

/**
 * For each name, the shortest prefix that tells it apart from every other
 * name, with an ellipsis when it is cut short: "Div Red" and "Div Green"
 * become "Div R…" and "Div G…", while "Division 1" and "Division 2" differ
 * only in their last character and stay whole.
 */
export function distinguishingPrefixes(names: string[]): string[] {
  const unique = [...new Set(names)];
  return unique.map((name) => {
    let shared = 0;
    for (const other of unique) {
      if (other === name) continue;
      shared = Math.max(shared, commonPrefixLength(name, other));
    }
    const length = shared + 1;
    return length >= name.length ? name : name.slice(0, length) + ELLIPSIS;
  });
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

export interface SizeColumnOptions {
  /** Text the header shows; measured bold, as the header renders it. */
  header: string;
  /** The column's cell values; blank ones don't count as data. */
  values: string[];
  /** Horizontal space around the text: cell padding plus any chrome. */
  padding: number;
  /**
   * How narrow the column may get:
   * - "header" (default): its header stays readable; values may be cut short.
   * - "content": its widest value stays whole (values that identify a row).
   * - `{ distinguish }`: enough of each listed name to tell them apart.
   */
  keep?: "header" | "content" | { distinguish: string[] };
  measure?: MeasureText;
}

export function sizeColumn({
  header,
  values,
  padding,
  keep = "header",
  measure = measureGridText(),
}: SizeColumnOptions): ColumnSizing {
  const present = values.filter((value) => value.trim() !== "");
  const headerWidth = measure(header, { bold: true });
  const widest = (texts: string[]) =>
    Math.max(headerWidth, ...texts.map((text) => measure(text, { bold: false })));
  // Round up: a sub-pixel shortfall still triggers the cell's ellipsis.
  const toWidth = (textWidth: number) => Math.ceil(textWidth + padding);

  const ideal = toWidth(widest(present));
  let min: number;
  if (keep === "content") min = ideal;
  else if (keep === "header") min = toWidth(headerWidth);
  else min = Math.min(ideal, toWidth(widest(distinguishingPrefixes(keep.distinguish))));
  return { min, ideal, hasData: present.length > 0 };
}

/** A column that never grows or shrinks, such as a row's action button. */
export function fixedColumn(width: number): ColumnSizing {
  return { min: width, ideal: width, hasData: false };
}

/**
 * Shares `available` pixels across the columns. Every column gets its
 * minimum; if that already overflows, the grid scrolls. Otherwise columns
 * with data grow toward their ideal, each by the same fraction of what it
 * still lacks. Once they all fit, the rest is split equally between them.
 * Widths are whole pixels and never add up to more than `available`, so
 * the grid only scrolls sideways when the minimums alone don't fit.
 */
export function allocateColumnWidths(columns: ColumnSizing[], available: number): number[] {
  const widths = columns.map((column) => column.min);
  let leftover = available - sum(widths);
  if (leftover <= 0) return widths;

  const growing = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => column.hasData);
  if (growing.length === 0) return widths;

  const shortfall = (column: ColumnSizing) => Math.max(0, column.ideal - column.min);
  const totalShortfall = sum(growing.map(({ column }) => shortfall(column)));

  if (leftover < totalShortfall) {
    const fraction = leftover / totalShortfall;
    for (const { column, index } of growing) {
      widths[index] = column.min + Math.floor(shortfall(column) * fraction);
    }
    return widths;
  }

  for (const { column, index } of growing) widths[index] = column.min + shortfall(column);
  leftover -= totalShortfall;
  const share = Math.floor(leftover / growing.length);
  for (const { index } of growing) widths[index] += share;
  return widths;
}

function sum(numbers: number[]): number {
  return numbers.reduce((total, n) => total + n, 0);
}

let cachedMeasure: MeasureText | null = null;

/** Measures text in the grid's own font (or estimates it, under jsdom). */
export function measureGridText(): MeasureText {
  cachedMeasure ??= canvasMeasure() ?? estimateMeasure;
  return cachedMeasure;
}

/** Grid cells use the app's sans stack at `--text-sm`. */
function gridFont(): { family: string; sizePx: number } {
  const style = getComputedStyle(document.documentElement);
  const rootPx = parseFloat(style.fontSize) || 16;
  const sizeRem = parseFloat(style.getPropertyValue("--text-sm")) || 0.875;
  const family = style.getPropertyValue("--font-sans").trim() || "sans-serif";
  return { family, sizePx: sizeRem * rootPx };
}

function canvasMeasure(): MeasureText | null {
  // OffscreenCanvas keeps measuring out of the DOM; jsdom has none, so
  // tests fall back to the estimate rather than logging canvas errors.
  if (typeof OffscreenCanvas === "undefined") return null;
  const context = new OffscreenCanvas(1, 1).getContext("2d");
  if (!context) return null;
  const { family, sizePx } = gridFont();
  return (text, { bold }) => {
    context.font = `${bold ? 600 : 400} ${sizePx}px ${family}`;
    return context.measureText(text).width;
  };
}

/** A generous per-character guess for environments without a canvas. */
const estimateMeasure: MeasureText = (text) => text.length * 14 * 0.6;
