import { createBrowserRouter, redirect } from "react-router-dom";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import type { EventRead } from "./types";
import { EventsNewRoute } from "./routes/EventsNewRoute";
import { LoginRoute } from "./routes/LoginRoute";
import { AuthenticatedLayout } from "./routes/AuthenticatedLayout";
import { DashboardRoute } from "./routes/DashboardRoute";
import { EventSetupRoute } from "./routes/EventSetupRoute";
import { SettingsRolesRoute } from "./routes/SettingsRolesRoute";
import { DivisionsRoute } from "./routes/DivisionsRoute";

async function eventExists(): Promise<boolean> {
  try {
    await apiRequest<EventRead>("/api/event");
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return false;
    }
    throw err;
  }
}

/**
 * GET /api/event is unauthenticated on the backend (no role credentials
 * exist until an event is created), so this check MUST happen before any
 * token check — see the spec's "Routing & guards" section. A fresh
 * install redirects to /events/new before any login is even possible.
 */
async function rootLoader() {
  if (!(await eventExists())) {
    return redirect("/events/new");
  }
  return null;
}

async function eventsNewLoader() {
  if (await eventExists()) {
    return redirect("/login");
  }
  return null;
}

export const router = createBrowserRouter([
  {
    path: "/events/new",
    loader: eventsNewLoader,
    element: <EventsNewRoute />,
  },
  {
    path: "/login",
    element: <LoginRoute />,
  },
  {
    path: "/",
    loader: rootLoader,
    element: <AuthenticatedLayout />,
    children: [
      { index: true, element: <DashboardRoute /> },
      { path: "events/setup", element: <EventSetupRoute /> },
      { path: "settings/roles", element: <SettingsRolesRoute /> },
      { path: "divisions", element: <DivisionsRoute /> },
    ],
  },
]);
