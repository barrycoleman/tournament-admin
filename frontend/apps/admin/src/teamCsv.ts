import Papa from "papaparse";

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
    let row: TeamGridRow = { ...next[targetRowIndex], dirty: true };
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
      row[key] = record[CSV_HEADERS[key]] ?? "";
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
      record[CSV_HEADERS[key]] = row[key];
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
