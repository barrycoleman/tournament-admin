import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SettingsRolesRoute } from "../../src/routes/SettingsRolesRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <SettingsRolesRoute />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

describe("SettingsRolesRoute", () => {
  it("loads the selected role's current password, masked by default", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/auth/passwords/admin") return { password: "correct-horse" } as never;
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    const field = (await screen.findByLabelText("Current password")) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("correct-horse"));
    expect(field.type).toBe("password");
  });

  it("toggles the current password field between masked and visible", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/auth/passwords/admin") return { password: "correct-horse" } as never;
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    const field = (await screen.findByLabelText("Current password")) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("correct-horse"));

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(field.type).toBe("text");

    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(field.type).toBe("password");
  });

  it("shows a hint and disables the reveal toggle when no password is stored for this role", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/auth/passwords/admin") return { password: null } as never;
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByText(/can't be shown/);
    expect(screen.getByRole("button", { name: "Show password" })).toBeDisabled();
  });

  it("refetches the current password for the newly selected role", async () => {
    const requestedPaths: string[] = [];
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      requestedPaths.push(path);
      if (path === "/api/auth/passwords/admin") return { password: "admin-pw" } as never;
      if (path === "/api/auth/passwords/scorer") return { password: "scorer-pw" } as never;
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    const field = (await screen.findByLabelText("Current password")) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("admin-pw"));

    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "scorer" } });

    await waitFor(() => expect(field.value).toBe("scorer-pw"));
    expect(requestedPaths).toContain("/api/auth/passwords/scorer");
  });

  it("refetches the current password after a successful password change", async () => {
    let storedPassword = "admin-pw";
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/auth/passwords/admin" && !options) {
        return { password: storedPassword } as never;
      }
      if (path === "/api/auth/passwords/admin" && (options as { method?: string })?.method === "PATCH") {
        storedPassword = (options as { body: { password: string } }).body.password;
        return undefined as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    const field = (await screen.findByLabelText("Current password")) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("admin-pw"));

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-admin-pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    await screen.findByRole("status");
    await waitFor(() => expect(field.value).toBe("new-admin-pw"));
  });
});
