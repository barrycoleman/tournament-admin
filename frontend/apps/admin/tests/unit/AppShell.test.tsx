import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { AppShell } from "../../src/components/AppShell";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return {
    ...actual,
    apiRequest: vi.fn(async () => ({})),
    useAuth: vi.fn(),
  };
});

import { useAuth } from "@tournament-admin/shared";

function renderShell() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <AppShell />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

describe("AppShell role-gated navigation", () => {
  it("shows only the Check-In link for the front_desk role", () => {
    vi.mocked(useAuth).mockReturnValue({
      role: "front_desk",
      isAuthenticated: true,
      login: vi.fn(),
      logout: vi.fn(),
    });
    renderShell();

    expect(screen.getByRole("link", { name: "Check-In" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Divisions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sessions" })).not.toBeInTheDocument();
  });

  it("shows the full admin nav including Sessions for the admin role", () => {
    vi.mocked(useAuth).mockReturnValue({
      role: "admin",
      isAuthenticated: true,
      login: vi.fn(),
      logout: vi.fn(),
    });
    renderShell();

    expect(screen.getByRole("link", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Check-In" })).not.toBeInTheDocument();
  });
});
