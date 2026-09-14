import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearStoredTokens, getStoredTokens, storeTokens } from "../src/tokenStorage";
import { RefreshError, refreshTokens } from "../src/refresh";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("refreshTokens", () => {
  it("throws without calling fetch when there is nothing stored", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(refreshTokens()).rejects.toThrow(RefreshError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts the stored refresh token and stores the new pair on success", async () => {
    storeTokens({ accessToken: "old-a", refreshToken: "old-r", expiresAt: 0 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-a",
          refresh_token: "new-r",
          expires_in: 1800,
        }),
        { status: 200 }
      )
    );

    const result = await refreshTokens();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/auth/refresh",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ refresh_token: "old-r" }),
      })
    );
    expect(result.accessToken).toBe("new-a");
    expect(getStoredTokens()?.accessToken).toBe("new-a");
  });

  it("clears storage and throws RefreshError on a non-2xx response", async () => {
    storeTokens({ accessToken: "old-a", refreshToken: "old-r", expiresAt: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Invalid or expired refresh token" }), {
        status: 401,
      })
    );

    await expect(refreshTokens()).rejects.toThrow(RefreshError);
    expect(getStoredTokens()).toBeNull();
  });
});
