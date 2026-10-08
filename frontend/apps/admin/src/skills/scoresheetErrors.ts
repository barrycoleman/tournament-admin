import { ApiError } from "@tournament-admin/shared";

/** A 422's per-field violations as field -> message, or null for any other error. */
export function violationsByField(error: unknown): Record<string, string> | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  const violations = (error.body as { violations?: unknown } | null)?.violations;
  if (!Array.isArray(violations) || violations.length === 0) return null;
  const byField: Record<string, string> = {};
  for (const violation of violations as { field?: unknown; message?: unknown }[]) {
    if (typeof violation.field === "string" && typeof violation.message === "string" && !(violation.field in byField)) {
      byField[violation.field] = violation.message;
    }
  }
  return byField;
}

export interface SplitViolations {
  /** Messages for fields the scoresheet shows, by field name. */
  byField: Record<string, string>;
  /** Messages for anything else, to show above Save. */
  other: string[];
}

/** A 422's violations split into those that map to a rendered field and those that don't; null when there are none to show. */
export function splitViolations(error: unknown, fieldNames: readonly string[]): SplitViolations | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  const violations = (error.body as { violations?: unknown } | null)?.violations;
  if (!Array.isArray(violations)) return null;
  const byField: Record<string, string> = {};
  const other: string[] = [];
  for (const violation of violations as { field?: unknown; message?: unknown }[]) {
    if (typeof violation?.message !== "string") continue;
    if (typeof violation.field === "string" && fieldNames.includes(violation.field)) {
      if (!(violation.field in byField)) byField[violation.field] = violation.message;
    } else {
      other.push(violation.message);
    }
  }
  return Object.keys(byField).length === 0 && other.length === 0 ? null : { byField, other };
}
