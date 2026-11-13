import { describe, expect, it, vi } from "vitest";
import type { RouteObject } from "react-router-dom";
import { routes } from "../../src/router";

// Importing the router module would otherwise start a real browser router (and its loaders) at import time.
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, createBrowserRouter: vi.fn(() => ({})) };
});

/** Finds the route whose full path is `pattern` and runs its loader the way the router would. */
async function redirectFrom(pattern: string, params: Record<string, string>): Promise<string> {
  function find(list: RouteObject[], prefix: string): RouteObject | undefined {
    for (const route of list) {
      const full = [prefix, route.path].filter(Boolean).join("/").replace(/\/+/g, "/");
      const here = full.startsWith("/") ? full : `/${full}`;
      if (here === pattern && route.loader) return route;
      const inner = route.children && find(route.children, here);
      if (inner) return inner;
    }
    return undefined;
  }
  const route = find(routes, "");
  if (!route?.loader || typeof route.loader !== "function") throw new Error(`no loader at ${pattern}`);
  const response = (await route.loader({ params, request: new Request("http://localhost/") } as never, undefined as never)) as Response;
  return response.headers.get("Location") ?? "";
}

describe("old addresses", () => {
  it.each([
    ["/displays", "/devices", {}],
    ["/divisions", "/teams/divisions", {}],
    ["/sessions/:sessionId", "/sessions/4/today", { sessionId: "4" }],
    ["/sessions/:sessionId/fields", "/sessions/4/setup", { sessionId: "4" }],
  ])("%s redirects to %s", async (pattern, to, params) => {
    expect(await redirectFrom(pattern, params)).toBe(to);
  });
});
