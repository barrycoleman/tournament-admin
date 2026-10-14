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
      if (role === "judge") {
        return redirect("/judge/awards");
      }
    } catch {
      // Malformed/undecodable token -- leave routing to rootLoader's
      // own auth flow rather than failing this loader.
    }
  }
  return null;
}

/**
 * Where to go after `role` signs in, given the page a signed-out visitor was
 * on. Only an admin, or a judge returning to a judge page, goes back there:
 * the page may be the previous user's, so anyone else goes to "/" and lets
 * indexLoader send them to their own landing page.
 */
export function returnPathAfterLogin(role: string, from: unknown): string {
  const path = safeReturnPath(from);
  if (path === null) return "/";
  if (role === "admin") return path;
  if (role === "judge" && judgeAllowedPath(path.split(/[?#]/)[0])) return path;
  return "/";
}

/** The only pages a judge can open: the judge pages and season rankings. */
export function judgeAllowedPath(pathname: string): boolean {
  return pathname === "/rankings" || pathname === "/judge" || pathname.startsWith("/judge/");
}

/** A same-app path to return to after signing in, or null for anything else
 * (an absolute URL or a protocol-relative "//host" would leave the app, and
 * browsers read a backslash as a slash, so "/\\host" is refused too). */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  return value;
}
