import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredTokens,
  getStoredTokens,
  storeTokens,
  tokensFromLoginResponse,
} from "../src/tokenStorage";

beforeEach(() => {
  localStorage.clear();
});

describe("tokenStorage", () => {
  it("returns null when nothing is stored", () => {
    expect(getStoredTokens()).toBeNull();
  });

  it("round-trips stored tokens", () => {
    storeTokens({ accessToken: "a", refreshToken: "r", expiresAt: 123 });
    expect(getStoredTokens()).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 123,
    });
  });

  it("clears stored tokens", () => {
    storeTokens({ accessToken: "a", refreshToken: "r", expiresAt: 123 });
    clearStoredTokens();
    expect(getStoredTokens()).toBeNull();
  });

  it("returns null for malformed stored JSON rather than throwing", () => {
    localStorage.setItem("tournament-admin.auth.v1", "{not json");
    expect(getStoredTokens()).toBeNull();
  });

  it("returns null when the stored shape is missing fields", () => {
    localStorage.setItem(
      "tournament-admin.auth.v1",
      JSON.stringify({ accessToken: "a" })
    );
    expect(getStoredTokens()).toBeNull();
  });
});

describe("tokensFromLoginResponse", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes expiresAt from the current time plus expires_in seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const result = tokensFromLoginResponse({
      access_token: "a",
      refresh_token: "r",
      expires_in: 1800,
    });
    expect(result).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: new Date("2026-01-01T00:30:00.000Z").getTime(),
    });
  });
});
