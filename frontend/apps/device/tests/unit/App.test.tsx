import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/i18nSetup";

vi.mock("qrcode", () => ({ default: { toCanvas: vi.fn(() => Promise.resolve()) } }));

import QRCode from "qrcode";
import { App } from "../../src/App";
import { clearDeviceToken } from "../../src/deviceApi";

const sockets: { url: string; onclose?: (e: { code: number }) => void; onopen?: () => void; close: () => void }[] = [];
class FakeSocket {
  url: string;
  onclose?: (e: { code: number }) => void;
  onmessage?: unknown;
  onopen?: () => void;
  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }
  close() {}
}

interface Answer {
  status: number;
  body?: unknown;
  /** Sent as-is instead of JSON, e.g. an HTML error page from a proxy. */
  raw?: string;
}
type Route = (url: string, init?: RequestInit) => Answer | Promise<Answer>;
function toResponse(answer: Answer): Response {
  const body = answer.raw ?? (answer.body === undefined ? null : JSON.stringify(answer.body));
  return new Response(body, { status: answer.status });
}
function serve(route: Route) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => toResponse(await route(String(input), init)));
}
function after(ms: number, answer: Answer): Promise<Answer> {
  return new Promise((resolve) => setTimeout(() => resolve(answer), ms));
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
  // Also forgets a token kept in memory when storage refused it.
  clearDeviceToken();
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

  it("still collects a pairing that lands after the device's countdown has run out", async () => {
    let oldPolls = 0;
    let codesIssued = 0;
    serve((url) => {
      if (url === "/api/pairing") {
        codesIssued += 1;
        return { status: 201, body: { ...CODE, id: `p${codesIssued}`, code: codesIssued === 1 ? "KX49TM" : "AAAAAA", expires_in: 5 } };
      }
      if (url === "/api/pairing/p1") {
        oldPolls += 1;
        // Waiting until after the 5 s countdown, then paired inside the server's grace.
        return { status: 200, body: oldPolls < 3 ? { status: "waiting" } : { status: "paired", device_token: "dt" } };
      }
      if (url.startsWith("/api/pairing/")) return { status: 200, body: { status: "waiting" } };
      if (url === "/api/auth/device") return { status: 200, body: { access_token: "a", expires_in: 1800, device: DEVICE } };
      return { status: 404 };
    });
    render(<App />);
    expect(await screen.findByTestId("pairing-code")).toHaveTextContent("KX4 9TM");
    await act(() => vi.advanceTimersByTimeAsync(5_500));
    expect(await screen.findByTestId("pairing-code")).toHaveTextContent("AAA AAA");
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(await screen.findByText("Field 1 Tablet")).toBeInTheDocument();
    expect(oldPolls).toBe(3);
    expect(localStorage.getItem("tournament-admin.device.v1")).toContain("dt");
  });

  it("never lets a later 404 throw away a slow paired answer", async () => {
    let polls = 0;
    let codesIssued = 0;
    serve((url) => {
      if (url === "/api/pairing") {
        codesIssued += 1;
        return { status: 201, body: CODE };
      }
      if (url.startsWith("/api/pairing/")) {
        polls += 1;
        // The first poll is slow and carries the token; the server forgets the
        // code once it has handed the token over, so any later poll is a 404.
        return polls === 1
          ? after(3_000, { status: 200, body: { status: "paired", device_token: "dt" } })
          : { status: 404, body: { detail: "Not found" } };
      }
      if (url === "/api/auth/device") return { status: 200, body: { access_token: "a", expires_in: 1800, device: DEVICE } };
      return { status: 404 };
    });
    render(<App />);
    await screen.findByTestId("pairing-code");
    // Separate act() calls so anything a 404 would do is committed before the
    // slow answer arrives.
    await act(() => vi.advanceTimersByTimeAsync(2_500));
    await act(() => vi.advanceTimersByTimeAsync(1_700));
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(await screen.findByText("Field 1 Tablet")).toBeInTheDocument();
    expect(codesIssued).toBe(1);
    expect(polls).toBe(1);
  });

  it("treats a garbled answer while pairing as a retryable failure", async () => {
    let requests = 0;
    serve((url) => {
      if (url === "/api/pairing") {
        requests += 1;
        return requests === 1 ? { status: 200, raw: "<html>proxy error</html>" } : { status: 201, body: CODE };
      }
      return { status: 200, body: { status: "waiting" } };
    });
    render(<App />);
    expect(await screen.findByText("Can't reach the server. Retrying…")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(await screen.findByTestId("pairing-code")).toBeInTheDocument();
    expect(screen.queryByText("Can't reach the server. Retrying…")).not.toBeInTheDocument();
  });

  it("treats a garbled sign-in answer as a retryable failure", async () => {
    localStorage.setItem("tournament-admin.device.v1", JSON.stringify({ deviceToken: "dt" }));
    let signIns = 0;
    serve((url) => {
      if (url !== "/api/auth/device") return { status: 404 };
      signIns += 1;
      return signIns === 1
        ? { status: 200, raw: "not json" }
        : { status: 200, body: { access_token: "a", expires_in: 1800, device: DEVICE } };
    });
    render(<App />);
    expect(await screen.findByText("Can't reach the server. Retrying…")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(await screen.findByText("Field 1 Tablet")).toBeInTheDocument();
    expect(screen.queryByText("Can't reach the server. Retrying…")).not.toBeInTheDocument();
    expect(localStorage.getItem("tournament-admin.device.v1")).toContain("dt");
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

  it("says the server can't be reached when the home screen's socket drops, and clears it on reconnect", async () => {
    localStorage.setItem("tournament-admin.device.v1", JSON.stringify({ deviceToken: "dt" }));
    serve((url) =>
      url === "/api/auth/device" ? { status: 200, body: { access_token: "a", expires_in: 1800, device: DEVICE } } : { status: 404 }
    );
    render(<App />);
    await screen.findByText("Field 1 Tablet");
    act(() => sockets[0].onopen?.());
    expect(screen.queryByText("Can't reach the server. Retrying…")).not.toBeInTheDocument();
    act(() => sockets[0].onclose?.({ code: 1006 }));
    expect(await screen.findByText("Can't reach the server. Retrying…")).toBeInTheDocument();
    expect(screen.getByText("Field 1 Tablet")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(sockets).toHaveLength(2);
    act(() => sockets[1].onopen?.());
    expect(screen.queryByText("Can't reach the server. Retrying…")).not.toBeInTheDocument();
  });

  it("checks its session again when the server refuses the socket with 1008", async () => {
    localStorage.setItem("tournament-admin.device.v1", JSON.stringify({ deviceToken: "dt" }));
    let signIns = 0;
    serve((url) => {
      if (url !== "/api/auth/device") return { status: 404 };
      signIns += 1;
      return { status: 200, body: { access_token: `a${signIns}`, expires_in: 1800, device: DEVICE } };
    });
    render(<App />);
    await screen.findByText("Field 1 Tablet");
    expect(signIns).toBe(1);
    act(() => sockets[0].onclose?.({ code: 1008 }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(signIns).toBe(2);
  });

  it("keeps a paired token in memory and reaches home when storage refuses to save it", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    let polls = 0;
    let codesIssued = 0;
    serve((url) => {
      if (url === "/api/pairing") {
        codesIssued += 1;
        return { status: 201, body: CODE };
      }
      if (url.startsWith("/api/pairing/")) {
        polls += 1;
        return { status: 200, body: { status: "paired", device_token: "dt" } };
      }
      if (url === "/api/auth/device") return { status: 200, body: { access_token: "a", expires_in: 1800, device: DEVICE } };
      return { status: 404 };
    });
    render(<App />);
    await screen.findByTestId("pairing-code");
    await act(() => vi.advanceTimersByTimeAsync(2_500));
    expect(await screen.findByText("Field 1 Tablet")).toBeInTheDocument();
    expect(codesIssued).toBe(1);
    expect(polls).toBe(1);
  });

  it("treats a storage read that throws as no token and shows a pairing code", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    serve((url) => (url === "/api/pairing" ? { status: 201, body: CODE } : { status: 200, body: { status: "waiting" } }));
    render(<App />);
    expect(await screen.findByTestId("pairing-code")).toBeInTheDocument();
  });
});
