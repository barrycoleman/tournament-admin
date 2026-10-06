import { useQueryClient } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import { RankingsView } from "../rankings/RankingsView";
import { rankingsKeyPrefix } from "../rankings/useRankingGroups";
import type { SessionRead } from "../types";

export function SessionRankingsRoute() {
  const { session } = useOutletContext<{ session: SessionRead }>();
  const queryClient = useQueryClient();
  const scope = { kind: "session" as const, sessionId: session.id };
  useRealtimeChannel({
    path: `/ws/session/${session.id}`,
    onEvent: (realtimeEvent: RealtimeEvent) => {
      if (realtimeEvent.event === "ranking_updated") {
        queryClient.invalidateQueries({ queryKey: rankingsKeyPrefix(scope) });
      }
    },
  });
  return <RankingsView scope={scope} />;
}
