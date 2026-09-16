import { useState } from "react";
import { apiRequest, ApiError } from "@tournament-admin/shared";

const RESTART_POLL_INTERVAL_MS = 500;
const RESTART_POLL_TIMEOUT_MS = 15_000;

export type RestartPollStatus = "idle" | "waiting" | "timedOut";

/**
 * Which app state the restarting server is expected to land in --
 * determines what a poll tick of GET /api/picker/directories counts as
 * "ready", since that route only exists in picker mode:
 *
 * - "normal" (create/open): the server is currently in picker mode and
 *   restarting into the normal app, so readiness is a 404 (the route
 *   stopped existing).
 * - "picker" (switch): the server is currently the normal app and
 *   restarting into picker mode, so readiness is the route responding
 *   successfully again -- waiting for a 404 here would fire
 *   immediately on the *old*, still-normal process (this route already
 *   404s there before the restart even happens), landing `onReady`
 *   far too early.
 */
export type RestartTarget = "normal" | "picker";

/**
 * After a picker action (create/open/switch) triggers a server restart,
 * this polls GET /api/picker/directories until the server reaches the
 * app state named by `target` (see `RestartTarget`), then calls
 * `onReady`. Defaults to a full page reload, since the caller is always
 * about to land on a different app state entirely.
 */
export function useRestartPoll(
  onReady: () => void = () => window.location.reload(),
  target: RestartTarget = "normal"
) {
  const [status, setStatus] = useState<RestartPollStatus>("idle");

  function start() {
    setStatus("waiting");
    const deadline = Date.now() + RESTART_POLL_TIMEOUT_MS;

    const tick = async () => {
      try {
        await apiRequest("/api/picker/directories");
        if (target === "picker") {
          onReady();
          return;
        }
      } catch (err) {
        if (target === "normal" && err instanceof ApiError && err.status === 404) {
          onReady();
          return;
        }
      }
      if (Date.now() > deadline) {
        setStatus("timedOut");
        return;
      }
      setTimeout(() => void tick(), RESTART_POLL_INTERVAL_MS);
    };
    void tick();
  }

  return { status, start };
}
