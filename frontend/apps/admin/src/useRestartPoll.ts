import { useState } from "react";
import { apiRequest, ApiError } from "@tournament-admin/shared";

const RESTART_POLL_INTERVAL_MS = 500;
const RESTART_POLL_TIMEOUT_MS = 15_000;

export type RestartPollStatus = "idle" | "waiting" | "timedOut";

/**
 * After a picker action (create/open/switch) triggers a server restart,
 * this polls GET /api/picker/directories until it stops being reachable
 * in picker mode: a 404 means the restarted process is now the normal
 * app (this route only exists in picker mode), which is the signal to
 * call `onReady`. Defaults to a full page reload, since the caller is
 * always about to land on a different app state entirely.
 */
export function useRestartPoll(onReady: () => void = () => window.location.reload()) {
  const [status, setStatus] = useState<RestartPollStatus>("idle");

  function start() {
    setStatus("waiting");
    const deadline = Date.now() + RESTART_POLL_TIMEOUT_MS;

    const tick = async () => {
      try {
        await apiRequest("/api/picker/directories");
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
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
