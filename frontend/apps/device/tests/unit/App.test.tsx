import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/i18nSetup";

vi.mock("qrcode", () => ({ default: { toCanvas: vi.fn(() => Promise.resolve()) } }));

import QRCode from "qrcode";
import { App } from "../../src/App";

const sockets: { url: string; onclose?: (e: { code: number }) => void; close: () => void }[] = [];
class FakeSocket {
  url: string;
  onclose?: (e: { code: number }) => void;
  onmessage?: unknown;
  onopen?: unknown;
  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }
  close() {}
}

type Route = (url: string, init?: RequestInit) => { status: number; body?: unknown } | Promise<never>;
function serve(route: Route) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const result = route(String(input), init);
    if (result instanceof Promise) return result;
    return Promise.resolve(
      new Response(result.body === undefined ? null : JSON.stringify(result.body), { status: result.status })
    );
  });
}

const CODE = { id: "p1", code: "KX49TM", poll_key: "k", expires_at: "2000-01-01T00:00:00Z", expires_in: 300 };
const DEVICE = { id: 7, name: "Field 1 Tablet", role: "scorer", status: "active" };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  sockets.length = 0;
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("device app", () => {
  it("shows a code and a QR link, and keeps it although the device clock is past expires_at", async () => {
    serve((url) => (url === "/api/pairing" ? { status: 201, body: CODE } : { status: 200, body: { status: "waiting" } }));
    render(<App />);
    expect(await screen.findByTestId("pairing-code")).toHaveTextContent("KX4 9TM");
    expect(QRCode.toCanvas).toHaveBeenCalledWith(
      expect.anything(),
      `${window.location.origin}/devices?pair=KX49TM`,
      expect.anything()
    );
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(screen.getByTestId("pairing-code")).toHaveTextContent("KX4 9TM");
  });

  it("asks for a new code when the countdown runs out", async () => {
    let issued = 0;
    serve((url) => {
      if (url === "/api/pairing") {
        issued += 1;
        return { status: 201, body: { ...CODE, id: `p${issued}`, code: issued === 1 ? "KX49TM" : "AAAAAA", expires_in: 5 } };
      }
      return { status: 200, body: { status: "waiting" } };
    });
    render(<App />);
    expect(await screen.findByTestId("pairing-code")).toHaveTextContent("KX4 9TM");
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(await screen.findByTestId("pairing-code")).toHaveTextContent("AAA AAA");
  });

  it("stores the token when paired and shows home", async () => {
    let polls = 0;
    serve((url) => {
      if (url === "/api/pairing") return { status: 201, body: CODE };
      if (url.startsWith("/api/pairing/")) {
        polls += 1;
        return { status: 200, body: polls < 2 ? { status: "waiting" } : { status: "paired", device_token: "dt" } };
      }
      if (url === "/api/auth/device") return { status: 200, body: { access_token: "a", expires_in: 1800, device: DEVICE } };
      return { status: 404 };
    });
    render(<App />);
    await screen.findByTestId("pairing-code");
    await act(() => vi.advanceTimersByTimeAsync(4_500));
    expect(await screen.findByText("Field 1 Tablet")).toBeInTheDocument();
    expect(screen.getByText(/Scorer/)).toBeInTheDocument();
    expect(localStorage.getItem("tournament-admin.device.v1")).toContain("dt");
  });

  it("retries the first sign-in after a fresh pairing when it is refused once, and shows home without re-pairing", async () => {
    let codesIssued = 0;
    let signIns = 0;
    serve((url) => {
      if (url === "/api/pairing") {
        codesIssued += 1;
        return { status: 201, body: CODE };
      }
      if (url.startsWith("/api/pairing/")) return { status: 200, body: { status: "paired", device_token: "dt" } };
      if (url === "/api/auth/device") {
        signIns += 1;
        return signIns === 1
          ? { status: 401, body: { detail: "This device is no longer paired" } }
          : { status: 200, body: { access_token: "a", expires_in: 1800, device: DEVICE } };
      }
      return { status: 404 };
    });
    render(<App />);
    await screen.findByTestId("pairing-code");
    await act(() => vi.advanceTimersByTimeAsync(2_500));
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(await screen.findByText("Field 1 Tablet")).toBeInTheDocument();
    expect(signIns).toBe(2);
    expect(codesIssued).toBe(1);
    expect(localStorage.getItem("tournament-admin.device.v1")).toContain("dt");
  });

  it("gives up after three refused sign-ins following a fresh pairing and pairs again", async () => {
    let codesIssued = 0;
    let signIns = 0;
    serve((url) => {
      if (url === "/api/pairing") {
        codesIssued += 1;
        return { status: 201, body: CODE };
      }
      if (url.startsWith("/api/pairing/")) {
        return { status: 200, body: codesIssued === 1 ? { status: "paired", device_token: "dt" } : { status: "waiting" } };
      }
      if (url === "/api/auth/device") {
        signIns += 1;
        return { status: 401, body: { detail: "This device is no longer paired" } };
      }
      return { status: 404 };
    });
    render(<App />);
    await screen.findByTestId("pairing-code");
    await act(() => vi.advanceTimersByTimeAsync(2_500));
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(await screen.findByTestId("pairing-code")).toBeInTheDocument();
    expect(signIns).toBe(3);
    expect(codesIssued).toBe(2);
    expect(localStorage.getItem("tournament-admin.device.v1")).toBeNull();
  });

  it("shows the disabled screen and returns home once enabled", async () => {
    localStorage.setItem("tournament-admin.device.v1", JSON.stringify({ deviceToken: "dt" }));
    let enabled = false;
    serve((url) =>
      url === "/api/auth/device"
        ? enabled
          ? { status: 200, body: { access_token: "a", expires_in: 1800, device: DEVICE } }
          : { status: 403, body: { detail: "This device is disabled", status: "disabled", name: "Field 1 Tablet" } }
        : { status: 404 }
    );
    render(<App />);
    expect(await screen.findByText("This device is disabled.")).toBeInTheDocument();
    enabled = true;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(await screen.findByText("Field 1 Tablet")).toBeInTheDocument();
  });

  it("clears a deleted device's token and shows a pairing code", async () => {
    localStorage.setItem("tournament-admin.device.v1", JSON.stringify({ deviceToken: "dt" }));
    let signIns = 0;
    serve((url) => {
      if (url === "/api/auth/device") {
        signIns += 1;
        return { status: 401, body: { detail: "gone" } };
      }
      if (url === "/api/pairing") return { status: 201, body: CODE };
      return { status: 200, body: { status: "waiting" } };
    });
    render(<App />);
    expect(await screen.findByTestId("pairing-code")).toBeInTheDocument();
    expect(localStorage.getItem("tournament-admin.device.v1")).toBeNull();
    // A stored token refused at startup is not retried.
    expect(signIns).toBe(1);
  });

  it("signs in again at once when the server closes the socket with 4403", async () => {
    localStorage.setItem("tournament-admin.device.v1", JSON.stringify({ deviceToken: "dt" }));
    let calls = 0;
    serve((url) => {
      if (url !== "/api/auth/device") return { status: 404 };
      calls += 1;
      return calls === 1
        ? { status: 200, body: { access_token: "a", expires_in: 1800, device: DEVICE } }
        : { status: 403, body: { detail: "This device is disabled", status: "disabled", name: "Field 1 Tablet" } };
    });
    render(<App />);
    await screen.findByText("Field 1 Tablet");
    expect(sockets[0].url).toContain("/ws/active-session?token=a");
    act(() => sockets[0].onclose?.({ code: 4403 }));
    expect(await screen.findByText("This device is disabled.")).toBeInTheDocument();
  });

  it("says when the server can't be reached and recovers", async () => {
    let up = false;
    serve((url) => {
      if (!up) return Promise.reject(new TypeError("down")) as never;
      return url === "/api/pairing" ? { status: 201, body: CODE } : { status: 200, body: { status: "waiting" } };
    });
    render(<App />);
    expect(await screen.findByText("Can't reach the server. Retrying…")).toBeInTheDocument();
    up = true;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(await screen.findByTestId("pairing-code")).toBeInTheDocument();
    expect(screen.queryByText("Can't reach the server. Retrying…")).not.toBeInTheDocument();
  });
});
