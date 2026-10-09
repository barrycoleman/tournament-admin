import { useOutletContext } from "react-router-dom";
import { AwardsView } from "../awards/AwardsView";
import { slotActionsFor } from "../awards/SlotActionButtons";
import type { SessionRead } from "../types";

export function JudgeAwardsRoute() {
  const { session, channelPath } = useOutletContext<{ session: SessionRead; channelPath: string }>();
  return (
    <AwardsView
      session={session}
      mode="judge"
      channelPath={channelPath}
      slotActions={slotActionsFor(session.id, "judge")}
    />
  );
}
