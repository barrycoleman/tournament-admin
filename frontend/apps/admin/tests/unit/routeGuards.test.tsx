import { describe, expect, it, afterEach } from "vitest";
import { clearStoredTokens, storeTokens } from "@tournament-admin/shared";
import { indexLoader, judgeAllowedPath } from "../../src/routeGuards";

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

  it("sends a judge from / to the judge awards page", () => {
    storeTokens({
      accessToken: fakeAccessToken("judge"),
      refreshToken: "refresh",
      expiresAt: Date.now() + 60_000,
    });
    const response = indexLoader() as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/judge/awards");
  });

  it("allows a judge only the judge pages and season rankings", () => {
    expect(judgeAllowedPath("/judge/awards")).toBe(true);
    expect(judgeAllowedPath("/judge/rankings")).toBe(true);
    expect(judgeAllowedPath("/rankings")).toBe(true);
    expect(judgeAllowedPath("/teams")).toBe(false);
    expect(judgeAllowedPath("/sessions/5/awards")).toBe(false);
    expect(judgeAllowedPath("/judgement")).toBe(false);
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
