import Papa from "papaparse";

// Excel/Sheets interpret a cell whose text begins with =, +, -, @, tab or
// CR as a formula when the exported file is opened. Prefix the standard
// single-quote guard on export and strip it again on import so
// export -> hand-edit -> re-upload stays lossless.
const FORMULA_TRIGGERS = ["=", "+", "-", "@", "\t", "\r"];

function needsFormulaGuard(value: string): boolean {
  const first = value.charAt(0);
  if (FORMULA_TRIGGERS.includes(first)) return true;
  // A value that legitimately starts with an apostrophe followed by a
  // trigger must be double-guarded, or import would strip the real one.
  return first === "'" && FORMULA_TRIGGERS.includes(value.charAt(1));
}

function escapeCsvCell(value: string): string {
  return needsFormulaGuard(value) ? `'${value}` : value;
}

function unescapeCsvCell(value: string): string {
  // Check whether the REST of the string (after the leading apostrophe)
  // still needs a guard, not just whether the next character is itself
  // a trigger -- a double-guarded value ("''=x", produced when the
  // original text was "'=x") has a second apostrophe in that position,
  // not the trigger, so a plain charAt(1) check never strips it.
  return value.startsWith("'") && needsFormulaGuard(value.slice(1))
    ? value.slice(1)
    : value;
}

export interface TeamGridRow {
  clientId: string;
  id: number | null;
  number: string;
  name: string;
  robot_name: string;
  organization: string;
  city: string;
  state: string;
  country: string;
  division: string;
  dirty: boolean;
  error?: string;
}

type TeamFieldKey =
  | "number"
  | "name"
  | "robot_name"
  | "organization"
  | "city"
  | "state"
  | "country"
  | "division";

export const TEAM_FIELD_KEYS: readonly TeamFieldKey[] = [
  "number",
  "name",
  "robot_name",
  "organization",
  "city",
  "state",
  "country",
  "division",
];

const CSV_HEADERS: Record<TeamFieldKey, string> = {
  number: "Number",
  name: "Name",
  robot_name: "Robot Name",
  organization: "Organization",
  city: "City",
  state: "State",
  country: "Country",
  division: "Division",
};

let rowIdCounter = 0;

export function makeBlankTeamRow(): TeamGridRow {
  rowIdCounter += 1;
  return {
    clientId: `new-${rowIdCounter}-${Date.now()}`,
    id: null,
    number: "",
    name: "",
    robot_name: "",
    organization: "",
    city: "",
    state: "",
    country: "",
    division: "",
    dirty: true,
  };
}

function setField(row: TeamGridRow, key: TeamFieldKey, value: string): TeamGridRow {
  return { ...row, [key]: value };
}

export function expandPastedBlock(
  pastedText: string,
  rows: TeamGridRow[],
  startRowIndex: number,
  startColumnKey: string
): TeamGridRow[] {
  const startColumnIndex = TEAM_FIELD_KEYS.indexOf(startColumnKey as TeamFieldKey);
  if (startColumnIndex === -1) {
    return rows;
  }

  const parsed = Papa.parse<string[]>(pastedText.replace(/\r?\n$/, ""), {
    delimiter: "\t",
  }).data;

  const next = [...rows];
  parsed.forEach((line, lineOffset) => {
    const targetRowIndex = startRowIndex + lineOffset;
    while (targetRowIndex >= next.length) {
      next.push(makeBlankTeamRow());
    }
    let row: TeamGridRow = { ...next[targetRowIndex], dirty: true, error: undefined };
    line.forEach((value, cellOffset) => {
      const key = TEAM_FIELD_KEYS[startColumnIndex + cellOffset];
      if (key) {
        row = setField(row, key, value);
      }
    });
    next[targetRowIndex] = row;
  });
  return next;
}

export function parseCsvFile(text: string): TeamGridRow[] {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  return parsed.data.map((record) => {
    const row = makeBlankTeamRow();
    for (const key of TEAM_FIELD_KEYS) {
      row[key] = unescapeCsvCell(record[CSV_HEADERS[key]] ?? "");
    }
    return row;
  });
}

export function teamsToCsv(
  rows: Pick<
    TeamGridRow,
    "number" | "name" | "robot_name" | "organization" | "city" | "state" | "country" | "division"
  >[]
): string {
  const data = rows.map((row) => {
    const record: Record<string, string> = {};
    for (const key of TEAM_FIELD_KEYS) {
      record[CSV_HEADERS[key]] = escapeCsvCell(row[key] ?? "");
    }
    return record;
  });
  return Papa.unparse(data, { columns: TEAM_FIELD_KEYS.map((key) => CSV_HEADERS[key]), newline: "\n" });
}

export const BLANK_TEAM_CSV_TEMPLATE = `${TEAM_FIELD_KEYS.map((key) => CSV_HEADERS[key]).join(",")}\n`;

export function downloadCsv(filename: string, csvContent: string): void {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
