import { describe, expect, it, afterEach } from "vitest";
import { clearStoredTokens, storeTokens } from "@tournament-admin/shared";
import { indexLoader } from "../../src/routeGuards";

/**
 * Builds a syntactically-valid (unsigned) JWT whose payload decodes to
 * the given role, matching what decodeAccessTokenPayload expects
 * (header.payload.signature, base64url, no verification performed
 * client-side).
 */
function fakeAccessToken(role: string): string {
  const header = btoa(JSON.stringify({ alg: "none" }));
  const payload = btoa(JSON.stringify({ role, iat: 0, exp: 9999999999 }));
  return `${header}.${payload}.signature`;
}

describe("indexLoader", () => {
  afterEach(() => {
    clearStoredTokens();
  });

  it("redirects front_desk to /checkin instead of the Dashboard", async () => {
    storeTokens({
      accessToken: fakeAccessToken("front_desk"),
      refreshToken: "refresh",
      expiresAt: Date.now() + 60_000,
    });

    const result = indexLoader();
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkin");
  });

  it("leaves admin on the Dashboard (no redirect)", () => {
    storeTokens({
      accessToken: fakeAccessToken("admin"),
      refreshToken: "refresh",
      expiresAt: Date.now() + 60_000,
    });

    expect(indexLoader()).toBeNull();
  });

  it("does nothing when no tokens are stored", () => {
    expect(indexLoader()).toBeNull();
  });
});
