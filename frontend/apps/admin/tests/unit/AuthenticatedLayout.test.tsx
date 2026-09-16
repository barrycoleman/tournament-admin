import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@tournament-admin/shared";
import { AuthenticatedLayout } from "../../src/routes/AuthenticatedLayout";
import "../../src/i18nSetup";

const STORAGE_KEY = "tournament-admin.auth.v1";

function makeAccessToken(role: string): string {
  const payload = btoa(
    JSON.stringify({ role, iat: 0, exp: Math.floor(Date.now() / 1000) + 3600 })
  );
  return `header.${payload}.signature`;
}

function storeValidTokens(role = "admin"): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      accessToken: makeAccessToken(role),
      refreshToken: "refresh-token-1",
      expiresAt: Date.now() + 3_600_000,
    })
  );
}

function renderShell() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/" element={<AuthenticatedLayout />}>
              <Route index element={<p>dashboard content</p>} />
            </Route>
            <Route path="/login" element={<p>login screen</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

describe("AuthenticatedLayout", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 }))
    );
  });

  it("redirects to /login when no tokens are stored", () => {
    renderShell();

    expect(screen.getByText("login screen")).toBeInTheDocument();
    expect(screen.queryByText("dashboard content")).not.toBeInTheDocument();
  });

  it("renders the shell and its nested route when tokens are stored", () => {
    storeValidTokens();
    renderShell();

    expect(screen.getByText("dashboard content")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("leaves for /login as soon as the user logs out of the mounted shell", async () => {
    storeValidTokens();
    renderShell();

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => {
      expect(screen.getByText("login screen")).toBeInTheDocument();
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(screen.queryByText("dashboard content")).not.toBeInTheDocument();
  });
});
