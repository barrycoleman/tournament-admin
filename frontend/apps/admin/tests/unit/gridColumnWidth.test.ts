import { describe, expect, it } from "vitest";
import {
  allocateColumnWidths,
  distinguishingPrefixes,
  fixedColumn,
  sizeColumn,
  type MeasureText,
} from "../../src/gridColumnWidth";

// 10px per character, 12px when bold -- easy to reason about.
const measure: MeasureText = (text, { bold }) => text.length * (bold ? 12 : 10);

describe("distinguishingPrefixes", () => {
  it("cuts names down to where they differ, with an ellipsis", () => {
    expect(distinguishingPrefixes(["Div Red", "Div Green"])).toEqual(["Div R…", "Div G…"]);
  });

  it("keeps names whole when they only differ at the end", () => {
    expect(distinguishingPrefixes(["Division 1", "Division 2"])).toEqual([
      "Division 1",
      "Division 2",
    ]);
  });

  it("keeps a name whole when it is a prefix of another", () => {
    expect(distinguishingPrefixes(["North", "Northeast"])).toEqual(["North", "Northe…"]);
  });

  it("needs only the first character of a lone name or of unrelated names", () => {
    expect(distinguishingPrefixes(["Alpha"])).toEqual(["A…"]);
    expect(distinguishingPrefixes(["Alpha", "Bravo", "Alpha"])).toEqual(["A…", "B…"]);
  });
});

describe("sizeColumn", () => {
  const base = { padding: 16, measure };

  it("keeps the header readable by default and wants its widest value", () => {
    const sizing = sizeColumn({ ...base, header: "City", values: ["Springfield", "Rome"] });
    expect(sizing).toEqual({ min: 4 * 12 + 16, ideal: 11 * 10 + 16, hasData: true });
  });

  it("treats a column of blank values as empty, sized to its header", () => {
    const sizing = sizeColumn({ ...base, header: "City", values: ["", "  "] });
    expect(sizing).toEqual({ min: 64, ideal: 64, hasData: false });
  });

  it("can keep its widest value whole", () => {
    const sizing = sizeColumn({ ...base, header: "#", values: ["101", "9999Z"], keep: "content" });
    expect(sizing.min).toBe(5 * 10 + 16);
    expect(sizing.min).toBe(sizing.ideal);
  });

  it("can keep just enough of each name to tell them apart", () => {
    const sizing = sizeColumn({
      ...base,
      header: "Div",
      values: ["Div Green"],
      keep: { distinguish: ["Div Red", "Div Green"] },
    });
    // "Div R…" / "Div G…" are 6 characters; the header is 3 bold ones.
    expect(sizing.min).toBe(6 * 10 + 16);
    expect(sizing.ideal).toBe(9 * 10 + 16);
  });

  it("never sets a minimum above what the content needs", () => {
    const sizing = sizeColumn({
      ...base,
      header: "D",
      values: ["Div A"],
      keep: { distinguish: ["Div A", "Div Abcdefghij"] },
    });
    expect(sizing.min).toBe(sizing.ideal);
  });

  it("rounds a fractional width up so the text is never a sub-pixel short", () => {
    const sizing = sizeColumn({ header: "", values: ["x"], padding: 0, measure: () => 100.2 });
    expect(sizing.ideal).toBe(101);
  });
});

describe("allocateColumnWidths", () => {
  const empty = { min: 50, ideal: 50, hasData: false };

  it("gives every column its minimum when even that doesn't fit", () => {
    const columns = [
      { min: 100, ideal: 300, hasData: true },
      empty,
    ];
    expect(allocateColumnWidths(columns, 120)).toEqual([100, 50]);
    expect(allocateColumnWidths(columns, 0)).toEqual([100, 50]);
  });

  it("grows only columns with data, each by the same share of what it lacks", () => {
    const columns = [
      { min: 100, ideal: 300, hasData: true }, // lacks 200
      { min: 100, ideal: 200, hasData: true }, // lacks 100
      empty,
      fixedColumn(80),
    ];
    // 330 of minimums, 150 to share: half of each shortfall.
    expect(allocateColumnWidths(columns, 480)).toEqual([200, 150, 50, 80]);
  });

  it("splits what's left equally between data columns once they all fit", () => {
    const columns = [
      { min: 100, ideal: 300, hasData: true },
      { min: 100, ideal: 200, hasData: true },
      empty,
      fixedColumn(80),
    ];
    // Ideals plus fixed columns take 630; 100 left over, 50 each.
    expect(allocateColumnWidths(columns, 730)).toEqual([350, 250, 50, 80]);
  });

  it("works the same when every column has data", () => {
    const columns = [
      { min: 60, ideal: 100, hasData: true },
      { min: 60, ideal: 100, hasData: true },
      { min: 60, ideal: 100, hasData: true },
    ];
    expect(allocateColumnWidths(columns, 240)).toEqual([80, 80, 80]);
    expect(allocateColumnWidths(columns, 330)).toEqual([110, 110, 110]);
  });

  it("leaves everything at its minimum when no column has data", () => {
    expect(allocateColumnWidths([empty, fixedColumn(80)], 1000)).toEqual([50, 80]);
  });

  it("never hands out more than the available width", () => {
    const columns = [
      { min: 10, ideal: 77, hasData: true },
      { min: 10, ideal: 91, hasData: true },
      { min: 10, ideal: 13, hasData: true },
    ];
    for (const available of [50, 101, 181, 333]) {
      const total = allocateColumnWidths(columns, available).reduce((a, b) => a + b, 0);
      expect(total).toBeLessThanOrEqual(available);
    }
  });
});
