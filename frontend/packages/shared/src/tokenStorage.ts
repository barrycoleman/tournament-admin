const STORAGE_KEY = "tournament-admin.auth.v1";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

interface LoginOrRefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function isStoredTokens(value: unknown): value is StoredTokens {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.accessToken === "string" &&
    typeof candidate.refreshToken === "string" &&
    typeof candidate.expiresAt === "number"
  );
}

export function getStoredTokens(): StoredTokens | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStoredTokens(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function storeTokens(tokens: StoredTokens): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
}

export function clearStoredTokens(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function tokensFromLoginResponse(
  response: LoginOrRefreshResponse
): StoredTokens {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: Date.now() + response.expires_in * 1000,
  };
}
