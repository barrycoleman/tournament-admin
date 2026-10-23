import { createBrowserRouter, redirect, type RouteObject } from "react-router-dom";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import { indexLoader } from "./routeGuards";
import type { EventRead } from "./types";
import { RequiresGamePlugin } from "./gamePlugin/NeedsGamePlugin";
import { EventsNewRoute } from "./routes/EventsNewRoute";
import { LoginRoute } from "./routes/LoginRoute";
import { PickerRoute } from "./routes/PickerRoute";
import { AuthenticatedLayout } from "./routes/AuthenticatedLayout";
import { HomeRoute } from "./routes/HomeRoute";
import { SessionNewRoute } from "./routes/SessionNewRoute";
import { TeamsLayout } from "./routes/TeamsLayout";
import { SessionPlaceholder } from "./routes/SessionPlaceholder";
import { EventSetupRoute } from "./routes/EventSetupRoute";
import { SettingsRolesRoute } from "./routes/SettingsRolesRoute";
import { BackupsRoute } from "./routes/BackupsRoute";
import { DevicesRoute } from "./routes/DevicesRoute";
import { MatchControlRoute } from "./routes/MatchControlRoute";
import { SkillsControlRoute } from "./routes/SkillsControlRoute";
import { DivisionsRoute } from "./routes/DivisionsRoute";
import { TeamsRoute } from "./routes/TeamsRoute";
import { SessionsRoute } from "./routes/SessionsRoute";
import { SeasonRankingsRoute } from "./routes/SeasonRankingsRoute";
import { SessionDetailLayout } from "./routes/SessionDetailLayout";
import { SessionCheckinRoute } from "./routes/SessionCheckinRoute";
import { SessionScheduleRoute } from "./routes/SessionScheduleRoute";
import { SessionMatchesRoute } from "./routes/SessionMatchesRoute";
import { MatchScoringRoute } from "./routes/MatchScoringRoute";
import { SessionSkillsRoute } from "./routes/SessionSkillsRoute";
import { SessionRankingsRoute } from "./routes/SessionRankingsRoute";
import { SessionAwardsRoute } from "./routes/SessionAwardsRoute";
import { JudgeLayout } from "./routes/JudgeLayout";
import { JudgeAwardsRoute } from "./routes/JudgeAwardsRoute";
import { FrontDeskCheckinRoute } from "./routes/FrontDeskCheckinRoute";

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

export const routes: RouteObject[] = [
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
      { index: true, loader: indexLoader, element: <HomeRoute /> },
      { path: "events/setup", element: <EventSetupRoute /> },
      { path: "settings/roles", element: <SettingsRolesRoute /> },
      { path: "backups", element: <BackupsRoute /> },
      { path: "devices", element: <DevicesRoute /> },
      { path: "match-control", element: <MatchControlRoute /> },
      { path: "skills-control", element: <RequiresGamePlugin><SkillsControlRoute /></RequiresGamePlugin> },
      { path: "displays", loader: () => redirect("/devices") },
      { path: "divisions", loader: () => redirect("/teams/divisions") },
      {
        path: "teams",
        element: <TeamsLayout />,
        children: [
          { index: true, element: <TeamsRoute /> },
          { path: "divisions", element: <DivisionsRoute /> },
        ],
      },
      { path: "sessions", element: <SessionsRoute /> },
      { path: "sessions/new", element: <SessionNewRoute /> },
      { path: "rankings", element: <RequiresGamePlugin><SeasonRankingsRoute /></RequiresGamePlugin> },
      { path: "checkin", element: <FrontDeskCheckinRoute /> },
      {
        path: "judge",
        element: <JudgeLayout />,
        children: [
          { index: true, loader: () => redirect("/judge/awards") },
          { path: "awards", element: <JudgeAwardsRoute /> },
          { path: "rankings", element: <RequiresGamePlugin><SessionRankingsRoute /></RequiresGamePlugin> },
        ],
      },
      {
        path: "sessions/:sessionId",
        element: <SessionDetailLayout />,
        children: [
          {
            index: true,
            loader: ({ params }) => redirect(`/sessions/${params.sessionId}/today`),
          },
          { path: "today", element: <SessionPlaceholder /> },
          { path: "setup", element: <SessionPlaceholder /> },
          { path: "checkin", element: <SessionCheckinRoute /> },
          { path: "fields", loader: ({ params }) => redirect(`/sessions/${params.sessionId}/setup`) },
          { path: "schedule", element: <SessionScheduleRoute /> },
          { path: "matches", element: <RequiresGamePlugin><SessionMatchesRoute /></RequiresGamePlugin> },
          { path: "matches/:matchId/score", element: <RequiresGamePlugin><MatchScoringRoute /></RequiresGamePlugin> },
          { path: "skills", element: <RequiresGamePlugin><SessionSkillsRoute /></RequiresGamePlugin> },
          { path: "rankings", element: <RequiresGamePlugin><SessionRankingsRoute /></RequiresGamePlugin> },
          { path: "awards", element: <SessionAwardsRoute /> },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
