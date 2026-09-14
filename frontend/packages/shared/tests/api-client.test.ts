import { beforeEach, describe, expect, it, vi } from "vitest";
import { storeTokens } from "../src/tokenStorage";
import { ApiError, apiRequest } from "../src/api-client";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("apiRequest", () => {
  it("attaches the stored bearer token and returns parsed JSON", async () => {
    storeTokens({ accessToken: "token-123", refreshToken: "r", expiresAt: 0 });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await apiRequest<{ ok: boolean }>("/api/event");

    expect(result).toEqual({ ok: true });
    const [, init] = fetchSpy.mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer token-123"
    );
  });

  it("sends no Authorization header when no tokens are stored", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await apiRequest("/api/event");

    const [, init] = fetchSpy.mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("JSON-encodes a plain body and sets Content-Type", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await apiRequest("/api/event", { method: "POST", body: { name: "x" } });

    const [, init] = fetchSpy.mock.calls[0];
    expect(init?.body).toBe(JSON.stringify({ name: "x" }));
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json"
    );
  });

  it("passes a FormData body through untouched, without a Content-Type header", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 201 }));
    const form = new FormData();

    await apiRequest("/api/plugins/games", {
      method: "POST",
      body: form,
      isFormData: true,
    });

    const [, init] = fetchSpy.mock.calls[0];
    expect(init?.body).toBe(form);
    expect(
      (init?.headers as Record<string, string>)["Content-Type"]
    ).toBeUndefined();
  });

  it("returns undefined for a 204 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const result = await apiRequest<undefined>("/api/auth/logout", { method: "POST" });
    expect(result).toBeUndefined();
  });

  it("throws ApiError with the response detail on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "nope" }), { status: 409 })
    );

    await expect(apiRequest("/api/event")).rejects.toMatchObject(
      new ApiError(409, "nope")
    );
  });

  it("on a 401, refreshes once and retries, returning the retried result", async () => {
    storeTokens({ accessToken: "stale", refreshToken: "r", expiresAt: 0 });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "fresh",
            refresh_token: "fresh-r",
            expires_in: 1800,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await apiRequest<{ ok: boolean }>("/api/event");

    expect(result).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const lastCallHeaders = fetchSpy.mock.calls[2][1]?.headers as Record<string, string>;
    expect(lastCallHeaders.Authorization).toBe("Bearer fresh");
  });

  it("throws ApiError(401, 'Session expired') when the refresh itself fails", async () => {
    storeTokens({ accessToken: "stale", refreshToken: "r", expiresAt: 0 });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    await expect(apiRequest("/api/event")).rejects.toMatchObject(
      new ApiError(401, "Session expired")
    );
  });
});
