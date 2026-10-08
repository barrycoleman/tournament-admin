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
