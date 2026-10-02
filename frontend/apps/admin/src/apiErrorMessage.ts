import { ApiError } from "@tournament-admin/shared";

/** A server-reported detail when there is a readable one, else `fallback`. FastAPI's own request-validation 422s carry a list, not a string, so those fall back too. */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && typeof error.detail === "string" && error.detail) {
    return error.detail;
  }
  return fallback;
}
