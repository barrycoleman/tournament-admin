import { createBrowserRouter, redirect } from "react-router-dom";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import type { EventRead } from "./types";
import { EventsNewRoute } from "./routes/EventsNewRoute";
import { LoginRoute } from "./routes/LoginRoute";
import { PickerRoute } from "./routes/PickerRoute";
import { AuthenticatedLayout } from "./routes/AuthenticatedLayout";
import { DashboardRoute } from "./routes/DashboardRoute";
import { EventSetupRoute } from "./routes/EventSetupRoute";
import { SettingsRolesRoute } from "./routes/SettingsRolesRoute";
import { DivisionsRoute } from "./routes/DivisionsRoute";
import { TeamsRoute } from "./routes/TeamsRoute";

async function isPickerMode(): Promise<boolean> {
  try {
    await apiRequest<unknown>("/api/picker/directories");
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return false;
    }
    throw err;
  }
}

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
 * The picker check MUST run before the event check, which in turn MUST
 * run before any token check: GET /api/picker/directories only exists
 * while no tournament has been chosen, and GET /api/event is
 * unauthenticated on the backend (no role credentials exist until an
 * event is created) -- see the tournament-picker design spec's
 * "Architecture & data flow" section and admin-ui-shell's "Routing &
 * guards" section. A fresh install with no tournament at all must reach
 * the picker screen before either later check is even meaningful.
 */
async function rootLoader() {
  if (await isPickerMode()) {
    return redirect("/picker");
  }
  if (!(await eventExists())) {
    return redirect("/events/new");
  }
  return null;
}

async function eventsNewLoader() {
  if (await isPickerMode()) {
    return redirect("/picker");
  }
  if (await eventExists()) {
    return redirect("/login");
  }
  return null;
}

async function loginLoader() {
  if (await isPickerMode()) {
    return redirect("/picker");
  }
  return null;
}

async function pickerLoader() {
  if (!(await isPickerMode())) {
    // A tournament is already resolved (e.g. direct navigation to
    // /picker after the server already restarted) -- send back to the
    // root, which re-runs its own resolution from here.
    return redirect("/");
  }
  return null;
}

export const router = createBrowserRouter([
  {
    path: "/picker",
    loader: pickerLoader,
    element: <PickerRoute />,
  },
  {
    path: "/events/new",
    loader: eventsNewLoader,
    element: <EventsNewRoute />,
  },
  {
    path: "/login",
    loader: loginLoader,
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
      { path: "teams", element: <TeamsRoute /> },
    ],
  },
]);
