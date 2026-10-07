import type { QualificationPreview } from "../types";

type Row = QualificationPreview["rows"][number];
export type FinalizeDraft = Record<string, string>;
export type DraftErrors = Record<string, { max: number }>;

export function draftFromRows(rows: Row[]): FinalizeDraft {
  return Object.fromEntries(rows.map((row) => [String(row.played), String(row.suggested)]));
}

/** Each row must be a whole number from 0 to played - 1. `drops` is null while any row is invalid. */
export function validateDraft(
  rows: Row[],
  draft: FinalizeDraft
): { drops: Record<string, number> | null; errors: DraftErrors } {
  const drops: Record<string, number> = {};
  const errors: DraftErrors = {};
  for (const row of rows) {
    const key = String(row.played);
    const text = (draft[key] ?? "").trim();
    const value = Number(text);
    const max = row.played - 1;
    if (text === "" || !Number.isInteger(value) || value < 0 || value > max) {
      errors[key] = { max };
    } else {
      drops[key] = value;
    }
  }
  return { drops: Object.keys(errors).length ? null : drops, errors };
}
