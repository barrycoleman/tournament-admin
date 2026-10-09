import { useOutletContext } from "react-router-dom";
import { AwardsView } from "../awards/AwardsView";
import type { SessionRead } from "../types";

export function SessionAwardsRoute() {
  const { session } = useOutletContext<{ session: SessionRead }>();
  return <AwardsView session={session} mode="admin" channelPath={`/ws/session/${session.id}`} />;
}
