import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RECONNECTED, useLiveEvents } from "./events";

/** Which cached reads each live event makes stale. */
const REFRESH: Record<string, readonly string[]> = {
  display_changed: ["me"],
  field_set_changed: ["me"],
  active_session_changed: ["me"],
  match_phase_changed: ["matches"],
  match_paused: ["matches"],
  match_resumed: ["matches"],
  match_reset: ["matches"],
  new_match_created: ["matches", "finals"],
  score_saved: ["matches", "scores", "finals"],
  qualification_status_changed: ["matches"],
  ranking_updated: ["rankings"],
  skills_changed: ["skillsRankings", "skillsAttempts"],
  skills_settings_changed: ["skillsSettings", "skillsRankings"],
  finals_changed: ["finals", "matches"],
};

/** Keeps every screen's data live. Returns how many times the socket has
 * (re)opened, so the server clock can be measured again after each. */
export function useLiveRefresh(): number {
  const queryClient = useQueryClient();
  const [opens, setOpens] = useState(0);
  useLiveEvents(null, (event) => {
    if (event.event === RECONNECTED || event.event === "game_plugin_changed") {
      void queryClient.invalidateQueries();
      if (event.event === RECONNECTED) setOpens((n) => n + 1);
      return;
    }
    for (const key of REFRESH[event.event] ?? []) void queryClient.invalidateQueries({ queryKey: [key] });
  });
  return opens;
}
