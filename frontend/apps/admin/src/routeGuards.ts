import { redirect } from "react-router-dom";
import { decodeAccessTokenPayload, getStoredTokens } from "@tournament-admin/shared";

/**
 * Index-route-only loader (meant to be attached to the "/" index route,
 * not the authenticated layout's own parent loader -- it must run only
 * for "/" itself, not for every route nested under it). front_desk's
 * shell only ever shows a link to /checkin (AppShell.tsx), and the
 * Dashboard's "edit event name" control 403s for that role, so a
 * front_desk login landing on "/" should go straight to /checkin
 * instead. Read synchronously off the stored JWT (via
 * getStoredTokens/decodeAccessTokenPayload) rather than useAuth(),
 * since loaders run as plain async functions outside the React tree.
 *
 * Kept in its own module (rather than inline in router.tsx) so it can
 * be unit-tested without importing router.tsx, whose module-level
 * `createBrowserRouter(...)` call kicks off a real navigation under
 * jsdom that isn't safe to trigger from a plain unit test.
 */
export function indexLoader(): Response | null {
  const tokens = getStoredTokens();
  if (tokens) {
    try {
      const { role } = decodeAccessTokenPayload(tokens.accessToken);
      if (role === "front_desk") {
        return redirect("/checkin");
      }
    } catch {
      // Malformed/undecodable token -- leave routing to rootLoader's
      // own auth flow rather than failing this loader.
    }
  }
  return null;
}
