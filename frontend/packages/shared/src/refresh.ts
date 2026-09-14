import {
  clearStoredTokens,
  getStoredTokens,
  storeTokens,
  tokensFromLoginResponse,
  type StoredTokens,
} from "./tokenStorage";

export class RefreshError extends Error {}

interface RefreshResponseBody {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/**
 * Rotates the refresh token: calls POST /api/auth/refresh directly via
 * fetch (never through shared/api-client) so a 401 here can never
 * trigger api-client's own refresh-and-retry loop and recurse.
 */
export async function refreshTokens(): Promise<StoredTokens> {
  const current = getStoredTokens();
  if (!current) {
    throw new RefreshError("No refresh token available");
  }

  const response = await fetch("/api/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: current.refreshToken }),
  });

  if (!response.ok) {
    clearStoredTokens();
    throw new RefreshError(`Refresh failed with status ${response.status}`);
  }

  const body = (await response.json()) as RefreshResponseBody;
  const next = tokensFromLoginResponse(body);
  storeTokens(next);
  return next;
}
