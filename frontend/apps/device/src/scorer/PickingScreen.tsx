import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { ApiStatusError, postJson } from "../deviceApi";
import { TokenContext, useRanks, useTeamsById, type FinalsBracket } from "../display/api";

type Action = "invite" | "accept" | "decline" | "cancel";

/** Partner picking on a tablet: the captain's invite, then the answer. */
export function PickingScreen({ bracket }: { bracket: FinalsBracket }) {
  const { t } = useTranslation();
  const getToken = useContext(TokenContext);
  const queryClient = useQueryClient();
  const teams = useTeamsById();
  const ranks = useRanks(bracket.session_id, bracket.division_id);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selection = bracket.selection;
  // Wait for the team numbers rather than flash ids.
  if (!selection || !teams) return null;
  const number = (id: number | null) => (id === null ? "" : (teams.get(id)?.number ?? String(id)));

  async function act(action: Action, teamId?: number) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await postJson(
        `/api/finals/${bracket.id}/selection/${action}`,
        action === "cancel" ? undefined : { team_id: teamId },
        getToken()
      );
    } catch (error) {
      // A stale or second answer: someone else got there first.
      setNotice(error instanceof ApiStatusError && error.status === 409 ? t("scorer.picking.stale") : t("scorer.picking.failed"));
    } finally {
      await queryClient.invalidateQueries({ queryKey: ["finals"] });
      setBusy(false);
    }
  }

  const pending = selection.pending_team_id;
  const captain = number(selection.captain_team_id);
  const sortedDeclined = [...selection.declined_team_ids].sort((a, b) => (ranks?.get(a) ?? 1e9) - (ranks?.get(b) ?? 1e9));
  const cards = [...selection.invitable_team_ids.map((id) => ({ id, declined: false })), ...sortedDeclined.map((id) => ({ id, declined: true }))];
  // Nothing a tablet can do until the organiser acts (no captain yet, or
  // nobody left to invite): say so rather than show an empty grid.
  const waiting = pending === null && (selection.captain_team_id === null || selection.invitable_team_ids.length === 0);

  return (
    <section className="picking" data-testid="picking-screen">
      {notice && (
        <p className="picking__notice" role="status">
          {notice}
        </p>
      )}
      {waiting ? (
        <p className="picking__prompt" data-testid="picking-waiting">
          {t("scorer.picking.waiting")}
        </p>
      ) : pending === null ? (
        <>
          <p className="picking__label">{t("scorer.picking.captain", { n: selection.alliances_formed + 1 })}</p>
          <p className="picking__captain" data-testid="captain-number">
            {captain}
          </p>
          <h1 className="picking__prompt">{t("scorer.picking.whoInvite")}</h1>
          <div className="picking__grid">
            {cards.map(({ id, declined: isDeclined }) => (
              <button
                key={id}
                type="button"
                className={`picking__team${isDeclined ? " is-declined" : ""}`}
                data-testid={`pick-team-${number(id)}`}
                disabled={isDeclined || busy}
                onClick={() => void act("invite", id)}
              >
                <span className="picking__team-number">{number(id)}</span>
                {ranks?.has(id) && <span className="picking__team-rank">#{ranks.get(id)}</span>}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="picking__label">{t("scorer.picking.invites", { captain })}</p>
          <p className="picking__invitee" data-testid="invitee-number">
            {number(pending)}
          </p>
          <div className="picking__answers">
            <button
              type="button"
              className="picking__answer picking__answer--accept"
              data-testid="accept-invite"
              disabled={busy}
              onClick={() => void act("accept", pending)}
            >
              {t("scorer.picking.accept")}
            </button>
            <button
              type="button"
              className="picking__answer picking__answer--decline"
              data-testid="decline-invite"
              disabled={busy}
              onClick={() => void act("decline", pending)}
            >
              {t("scorer.picking.decline")}
            </button>
          </div>
          <button type="button" className="picking__cancel" data-testid="cancel-invite" disabled={busy} onClick={() => void act("cancel")}>
            {t("scorer.picking.cancelInvite")}
          </button>
        </>
      )}
    </section>
  );
}
