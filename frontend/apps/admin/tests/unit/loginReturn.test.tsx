import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@tournament-admin/shared";
import { clearExplicitLogout, safeReturnPath } from "../../src/routeGuards";
import { AuthenticatedLayout } from "../../src/routes/AuthenticatedLayout";
import { LoginRoute } from "../../src/routes/LoginRoute";
import "../../src/i18nSetup";

const login = vi.fn();
// The real provider's login, for a test that signs in for real.
let realLogin: ((role: string, password: string) => Promise<void>) | null = null;

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return {
    ...actual,
    // The layout test needs the real provider's signed-out state; the login
    // tests only need a login() that succeeds.
    useAuth: () => {
      const real = actual.useAuth();
      realLogin = real.login;
      return { ...real, login };
    },
  };
});

function LocationProbe({ label }: { label: string }) {
  const location = useLocation();
  return (
    <p>
      {label} at {location.pathname}
      {location.search} from {JSON.stringify((location.state as { from?: string } | null)?.from ?? null)}
    </p>
  );
}

function renderApp(initialEntry: string | { pathname: string; state?: unknown }) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/" element={<AuthenticatedLayout />}>
              <Route index element={<LocationProbe label="dashboard" />} />
              <Route path="devices" element={<LocationProbe label="devices" />} />
            </Route>
            <Route path="/login" element={<LoginRoute />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

describe("safeReturnPath", () => {
  it("keeps a same-app path and refuses anything that leaves the app", () => {
    expect(safeReturnPath("/devices?pair=X")).toBe("/devices?pair=X");
    expect(safeReturnPath("//evil.example")).toBeNull();
    expect(safeReturnPath("https://x")).toBeNull();
    expect(safeReturnPath(42)).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
    expect(safeReturnPath("devices")).toBeNull();
    expect(safeReturnPath("/\\evil.example")).toBeNull();
    expect(safeReturnPath("/devices\\x")).toBeNull();
  });
});

describe("returning after sign-in", () => {
  beforeEach(() => {
    localStorage.clear();
    clearExplicitLogout();
    login.mockReset();
    login.mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 }))
    );
  });

  it("sends a signed-out visitor to /login remembering where they were going", () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter initialEntries={["/devices?pair=X"]}>
            <Routes>
              <Route path="/" element={<AuthenticatedLayout />}>
                <Route path="devices" element={<p>devices content</p>} />
              </Route>
              <Route path="/login" element={<LocationProbe label="login" />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>
    );
    expect(screen.getByText('login at /login from "/devices?pair=X"')).toBeInTheDocument();
    expect(screen.queryByText("devices content")).not.toBeInTheDocument();
  });

  it("goes back to the remembered page after a successful login", async () => {
    // Signing in stores no tokens here (login is mocked), so the shell would
    // bounce straight back to /login; probe the navigation target instead.
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter initialEntries={[{ pathname: "/login", state: { from: "/devices?pair=X" } }]}>
            <Routes>
              <Route path="/login" element={<LoginRoute />} />
              <Route path="/devices" element={<LocationProbe label="devices" />} />
              <Route path="/" element={<LocationProbe label="dashboard" />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>
    );
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(screen.getByText(/^devices at \/devices\?pair=X/)).toBeInTheDocument());
    expect(login).toHaveBeenCalledWith("admin", "secret");
  });

  function signInFrom(from: string, role: string) {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter initialEntries={[{ pathname: "/login", state: { from } }]}>
            <Routes>
              <Route path="/login" element={<LoginRoute />} />
              <Route path="/devices" element={<LocationProbe label="devices" />} />
              <Route path="/rankings" element={<LocationProbe label="rankings" />} />
              <Route path="/" element={<LocationProbe label="dashboard" />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>
    );
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: role } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  }

  it("returns an admin to an admin page", async () => {
    signInFrom("/devices", "admin");
    expect(await screen.findByText(/^devices at \/devices/)).toBeInTheDocument();
  });

  it("sends front_desk to the index, not the previous user's admin page", async () => {
    signInFrom("/devices", "front_desk");
    expect(await screen.findByText(/^dashboard at \//)).toBeInTheDocument();
    expect(login).toHaveBeenCalledWith("front_desk", "secret");
  });

  it("returns a judge only to a page a judge can open", async () => {
    signInFrom("/rankings", "judge");
    expect(await screen.findByText(/^rankings at \/rankings/)).toBeInTheDocument();
  });

  it("sends a judge to the index instead of an admin page", async () => {
    signInFrom("/devices", "judge");
    expect(await screen.findByText(/^dashboard at \//)).toBeInTheDocument();
  });

  it("goes to the dashboard after login when there is nowhere to return to", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter initialEntries={["/login"]}>
            <Routes>
              <Route path="/login" element={<LoginRoute />} />
              <Route path="/" element={<LocationProbe label="dashboard" />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>
    );
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByText(/^dashboard at \//)).toBeInTheDocument();
  });

  it("ignores a return path that would leave the app", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter initialEntries={[{ pathname: "/login", state: { from: "//evil.example" } }]}>
            <Routes>
              <Route path="/login" element={<LoginRoute />} />
              <Route path="/" element={<LocationProbe label="dashboard" />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>
    );
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByText(/^dashboard at \//)).toBeInTheDocument();
  });

  it("links to the device pairing page from the sign-in page", () => {
    renderApp("/login");
    expect(screen.getByRole("link", { name: "Pair this device" })).toHaveAttribute("href", "/pair");
  });

  it("records no return path after an explicit logout, so the next admin lands on the index", async () => {
    const accessToken = (role: string) =>
      `header.${btoa(JSON.stringify({ role, iat: 0, exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
    localStorage.setItem(
      "tournament-admin.auth.v1",
      JSON.stringify({ accessToken: accessToken("front_desk"), refreshToken: "r1", expiresAt: Date.now() + 3_600_000 })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/api/auth/login")
          ? new Response(
              JSON.stringify({ access_token: accessToken("admin"), refresh_token: "r2", expires_in: 3600 }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
          : new Response(null, { status: 204 })
      )
    );
    login.mockImplementation((role: string, password: string) => realLogin!(role, password));

    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter initialEntries={["/checkin"]}>
            <Routes>
              <Route path="/" element={<AuthenticatedLayout />}>
                <Route index element={<LocationProbe label="dashboard" />} />
                <Route path="checkin" element={<LocationProbe label="checkin" />} />
              </Route>
              <Route
                path="/login"
                element={
                  <>
                    <LocationProbe label="login" />
                    <LoginRoute />
                  </>
                }
              />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>
    );
    expect(screen.getByText("checkin at /checkin from null")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByText("login at /login from null")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    // Signed in for real: the shell renders the index, not the previous user's /checkin.
    expect(await screen.findByText("dashboard at / from null")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
    expect(login).toHaveBeenCalledWith("admin", "secret");
  });
});
