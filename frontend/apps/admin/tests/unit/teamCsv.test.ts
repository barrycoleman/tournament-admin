import { describe, expect, it } from "vitest";
import {
  BLANK_TEAM_CSV_TEMPLATE,
  expandPastedBlock,
  makeBlankTeamRow,
  parseCsvFile,
  teamsToCsv,
  type TeamGridRow,
} from "../../src/teamCsv";

describe("makeBlankTeamRow", () => {
  it("returns a row with a unique clientId, no id, all fields blank, and dirty true", () => {
    const a = makeBlankTeamRow();
    const b = makeBlankTeamRow();
    expect(a.clientId).not.toBe(b.clientId);
    expect(a.id).toBeNull();
    expect(a.number).toBe("");
    expect(a.dirty).toBe(true);
  });
});

describe("expandPastedBlock", () => {
  function rowsFixture(): TeamGridRow[] {
    return [
      { ...makeBlankTeamRow(), clientId: "r0", number: "0001A", name: "Existing", dirty: false },
    ];
  }

  it("updates a single cell when the paste is one line, one column", () => {
    const rows = rowsFixture();
    const result = expandPastedBlock("New Name", rows, 0, "name");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("New Name");
    expect(result[0].dirty).toBe(true);
    expect(result[0].number).toBe("0001A"); // untouched
  });

  it("spreads a multi-column line across adjacent columns starting at the target", () => {
    const rows = rowsFixture();
    const result = expandPastedBlock("0002B\tNew Name\tIroncladBot", rows, 0, "number");
    expect(result[0].number).toBe("0002B");
    expect(result[0].name).toBe("New Name");
    expect(result[0].robot_name).toBe("IroncladBot");
  });

  it("appends new rows when the pasted block has more lines than existing rows", () => {
    const rows = rowsFixture();
    const result = expandPastedBlock("0001A\tRow One\n0002B\tRow Two\n0003C\tRow Three", rows, 0, "number");
    expect(result).toHaveLength(3);
    expect(result[1].number).toBe("0002B");
    expect(result[1].name).toBe("Row Two");
    expect(result[2].number).toBe("0003C");
  });

  it("does nothing and returns the rows unchanged when the start column is unrecognized", () => {
    const rows = rowsFixture();
    const result = expandPastedBlock("x", rows, 0, "__not_a_column");
    expect(result).toBe(rows);
  });
});

describe("parseCsvFile", () => {
  it("parses a CSV with a header row into team grid rows", () => {
    const csv =
      "Number,Name,Robot Name,Organization,City,State,Country,Division\n" +
      "1234A,Robo Raiders,Ironclad,St Catherine School,Springfield,IL,USA,Elementary\n";
    const rows = parseCsvFile(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].number).toBe("1234A");
    expect(rows[0].robot_name).toBe("Ironclad");
    expect(rows[0].division).toBe("Elementary");
    expect(rows[0].dirty).toBe(true);
  });

  it("handles a quoted field containing a comma", () => {
    const csv =
      "Number,Name,Robot Name,Organization,City,State,Country,Division\n" +
      '1234A,"Golden Gears, Inc.",,,,,,\n';
    const rows = parseCsvFile(csv);
    expect(rows[0].name).toBe("Golden Gears, Inc.");
  });

  it("returns an empty array for a header-only CSV", () => {
    const csv = "Number,Name,Robot Name,Organization,City,State,Country,Division\n";
    expect(parseCsvFile(csv)).toEqual([]);
  });
});

describe("teamsToCsv", () => {
  it("produces a CSV with the header row and one line per team", () => {
    const csv = teamsToCsv([
      {
        number: "1234A",
        name: "Robo Raiders",
        robot_name: "Ironclad",
        organization: "St Catherine School",
        city: "Springfield",
        state: "IL",
        country: "USA",
        division: "Elementary",
      },
    ]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("Number,Name,Robot Name,Organization,City,State,Country,Division");
    expect(lines[1]).toBe("1234A,Robo Raiders,Ironclad,St Catherine School,Springfield,IL,USA,Elementary");
  });

  it("quotes a field containing a comma", () => {
    const csv = teamsToCsv([
      {
        number: "1234A",
        name: "Golden Gears, Inc.",
        robot_name: "",
        organization: "",
        city: "",
        state: "",
        country: "",
        division: "",
      },
    ]);
    expect(csv).toContain('"Golden Gears, Inc."');
  });
});

describe("BLANK_TEAM_CSV_TEMPLATE", () => {
  it("is just the header row", () => {
    expect(BLANK_TEAM_CSV_TEMPLATE.trim()).toBe(
      "Number,Name,Robot Name,Organization,City,State,Country,Division"
    );
  });
});
