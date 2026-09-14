import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, hasValidTokens, useAuth } from "../src/auth";
import { getStoredTokens } from "../src/tokenStorage";

function base64url(input: object): string {
  const json = JSON.stringify(input);
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeAccessToken(role: string, exp: number): string {
  return `${base64url({ alg: "HS256" })}.${base64url({ role, iat: 0, exp })}.unsigned`;
}

function Probe() {
  const { isAuthenticated, role, login, logout } = useAuth();
  return (
    <div>
      <p>authenticated: {String(isAuthenticated)}</p>
      <p>role: {role ?? "none"}</p>
      <button onClick={() => login("admin", "secret")}>login</button>
      <button onClick={() => logout()}>logout</button>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("AuthProvider / useAuth", () => {
  it("starts unauthenticated when nothing is stored", () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    expect(screen.getByText("authenticated: false")).toBeInTheDocument();
    expect(hasValidTokens()).toBe(false);
  });

  it("login stores tokens and exposes the decoded role", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: fakeAccessToken("admin", 9999999999),
          refresh_token: "r",
          expires_in: 1800,
        }),
        { status: 200 }
      )
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await act(async () => {
      screen.getByText("login").click();
    });

    await waitFor(() => {
      expect(screen.getByText("authenticated: true")).toBeInTheDocument();
      expect(screen.getByText("role: admin")).toBeInTheDocument();
    });
    expect(hasValidTokens()).toBe(true);
  });

  it("logout clears local state even when the server call fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: fakeAccessToken("admin", 9999999999),
            refresh_token: "r",
            expires_in: 1800,
          }),
          { status: 200 }
        )
      )
      // logout's own POST fails, then its 401-triggered refresh attempt also fails
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValue(new Response(null, { status: 500 }));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await act(async () => {
      screen.getByText("login").click();
    });
    await waitFor(() => screen.getByText("authenticated: true"));

    await act(async () => {
      screen.getByText("logout").click();
    });

    await waitFor(() => {
      expect(screen.getByText("authenticated: false")).toBeInTheDocument();
    });
    expect(getStoredTokens()).toBeNull();
  });

  it("schedules a silent refresh 30 seconds before expiry", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    localStorage.setItem(
      "tournament-admin.auth.v1",
      JSON.stringify({
        accessToken: fakeAccessToken("admin", 9999999999),
        refreshToken: "r",
        expiresAt: now + 5000,
      })
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: fakeAccessToken("admin", 9999999999),
          refresh_token: "r2",
          expires_in: 1800,
        }),
        { status: 200 }
      )
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    // Refresh fires at expiresAt - 30s, i.e. -25s from now — already due,
    // so it should fire on the next timer tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/auth/refresh",
      expect.objectContaining({ method: "POST" })
    );
  });
});
