import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Unreachable,
  clearDeviceToken,
  getDeviceToken,
  pollPairing,
  requestPairingCode,
  signIn,
  storeDeviceToken,
} from "../../src/deviceApi";

function respond(status: number, body?: unknown) {
  return Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status }));
}

describe("device storage", () => {
  beforeEach(() => localStorage.clear());

  it("keeps its own key and never touches the admin's sign-in", () => {
    localStorage.setItem("tournament-admin.auth.v1", "admin-tokens");
    storeDeviceToken("device-secret");
    expect(getDeviceToken()).toBe("device-secret");
    expect(localStorage.getItem("tournament-admin.device.v1")).toContain("device-secret");
    clearDeviceToken();
    expect(getDeviceToken()).toBeNull();
    expect(localStorage.getItem("tournament-admin.auth.v1")).toBe("admin-tokens");
  });

  it("treats garbage in storage as no token", () => {
    localStorage.setItem("tournament-admin.device.v1", "{not json");
    expect(getDeviceToken()).toBeNull();
  });
});

describe("device requests", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requests a pairing code", async () => {
    const code = { id: "p1", code: "KX49TM", poll_key: "k", expires_at: "x", expires_in: 300 };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => respond(201, code));
    await expect(requestPairingCode()).resolves.toEqual(code);
    expect(fetchMock).toHaveBeenCalledWith("/api/pairing", expect.objectContaining({ method: "POST" }));
  });

  it("polls with the key and treats 404 as expired", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => respond(404, { detail: "Not found" }));
    await expect(pollPairing({ id: "p1", poll_key: "k" })).resolves.toEqual({ status: "expired" });
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toEqual({ "X-Pairing-Key": "k" });
  });

  it("maps sign-in answers", async () => {
    const device = { id: 1, name: "Tab", role: "scorer", status: "active" };
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() =>
      respond(200, { access_token: "a", expires_in: 1800, device })
    );
    await expect(signIn("t")).resolves.toEqual({ kind: "active", accessToken: "a", expiresIn: 1800, device });
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() =>
      respond(403, { detail: "This device is disabled", status: "idle", name: "Tab" })
    );
    await expect(signIn("t")).resolves.toEqual({ kind: "blocked", status: "idle", name: "Tab" });
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => respond(401, { detail: "gone" }));
    await expect(signIn("t")).resolves.toEqual({ kind: "unknown" });
  });

  it("reports a network failure or a server error as unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => Promise.reject(new TypeError("down")));
    await expect(signIn("t")).rejects.toBeInstanceOf(Unreachable);
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => respond(502));
    await expect(requestPairingCode()).rejects.toBeInstanceOf(Unreachable);
  });

  it("reports an answer that isn't JSON as unreachable", async () => {
    const garbled = () => Promise.resolve(new Response("<html>proxy error</html>", { status: 200 }));
    vi.spyOn(globalThis, "fetch").mockImplementation(garbled);
    await expect(requestPairingCode()).rejects.toBeInstanceOf(Unreachable);
    await expect(pollPairing({ id: "p1", poll_key: "k" })).rejects.toBeInstanceOf(Unreachable);
    await expect(signIn("t")).rejects.toBeInstanceOf(Unreachable);
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response("nope", { status: 403 }))
    );
    await expect(signIn("t")).rejects.toBeInstanceOf(Unreachable);
  });
});
