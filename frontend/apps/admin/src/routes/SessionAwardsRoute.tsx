import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutletContext } from "react-router-dom";
import { AwardsView } from "../awards/AwardsView";
import { FinalizeAwardsDialog } from "../awards/FinalizeAwardsDialog";
import { slotActionsFor } from "../awards/SlotActionButtons";
import type { SessionRead } from "../types";

export function SessionAwardsRoute() {
  const { t } = useTranslation();
  const { session } = useOutletContext<{ session: SessionRead }>();
  const [finalizing, setFinalizing] = useState(false);
  return (
    <>
      <AwardsView
        session={session}
        mode="admin"
        channelPath={`/ws/session/${session.id}`}
        slotActions={slotActionsFor(session.id, "admin")}
        finalizeControl={() => (
          <button type="button" className="btn btn-primary" onClick={() => setFinalizing(true)}>
            {t("awards.finalizeAction")}
          </button>
        )}
      />
      {finalizing && <FinalizeAwardsDialog sessionId={session.id} onClose={() => setFinalizing(false)} />}
    </>
  );
}
