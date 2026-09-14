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

let inFlight: Promise<StoredTokens> | null = null;
let generation = 0;

/**
 * Invalidates any refresh currently in flight so it can't re-populate
 * storage or revive auth state after logout() has already cleared both.
 * Called by auth.tsx's logout().
 */
export function invalidateRefreshes(): void {
  generation += 1;
  inFlight = null;
}

/**
 * Coordinates concurrent callers onto a single in-flight refresh, since
 * the backend's refresh token is one-shot: a second concurrent POST with
 * the same (now-consumed) refresh token would 401 and wrongly look like
 * a real failure, clearing storage and logging the user out mid-session.
 */
export function refreshTokens(): Promise<StoredTokens> {
  if (!inFlight) {
    const mine = generation;
    const pending = doRefresh(mine).finally(() => {
      // Only clear the slot if it is still ours: invalidateRefreshes()
      // may already have cleared it (and a newer refresh may have taken
      // its place), and we must not evict that newer one.
      if (inFlight === pending) {
        inFlight = null;
      }
    });
    inFlight = pending;
  }
  return inFlight;
}

/**
 * Rotates the refresh token: calls POST /api/auth/refresh directly via
 * fetch (never through shared/api-client) so a 401 here can never
 * trigger api-client's own refresh-and-retry loop and recurse.
 *
 * `mine` is the logout generation this call started in. If a logout
 * bumps the generation while the request is in flight, this call's
 * response is stale: it still resolves/rejects normally for whoever is
 * awaiting it, but must not touch token storage — otherwise a late
 * success would re-populate localStorage (and revive auth state) after
 * an explicit logout already cleared it.
 */
async function doRefresh(mine: number): Promise<StoredTokens> {
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
    if (mine === generation) {
      clearStoredTokens();
    }
    throw new RefreshError(`Refresh failed with status ${response.status}`);
  }

  const body = (await response.json()) as RefreshResponseBody;
  const next = tokensFromLoginResponse(body);
  if (mine !== generation) {
    // Logged out while this was in flight — the new tokens are real, but
    // nobody is logged in any more, so they must not be persisted.
    throw new RefreshError("Refresh superseded by logout");
  }
  storeTokens(next);
  return next;
}
