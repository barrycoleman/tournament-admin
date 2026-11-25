import { useTranslation } from "react-i18next";
import { useNewestFinals, useRanks, useTeamsById } from "../api";
import { FitLine } from "../components/FitText";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import type { ScreenModule, ScreenProps } from "../screenTypes";

function AllianceSelectionScreen({ context }: ScreenProps) {
  const { t } = useTranslation();
  const bracket = useNewestFinals(context.sessionId, context.divisionId);
  const teams = useTeamsById();
  const ranks = useRanks(context.sessionId, bracket?.division_id ?? context.divisionId);
  const title = t("display.screens.alliance_selection");
  if (bracket === undefined || !teams || !ranks) return <WaitingForData title={title} />;
  if (bracket === null) return <ScreenNotice title={title} text={t("display.noAllianceSelection")} />;
  const selection = bracket.selection;
  // Once picking is over the list stays up; a bracket that never picked has nothing to show.
  if (bracket.alliance_selection !== "captain_pick" || (!selection && bracket.alliances.length === 0)) {
    return <ScreenNotice title={title} text={t("display.noAllianceSelection")} />;
  }
  const number = (id: number | null | undefined) => (id == null ? "" : teams.get(id)?.number ?? "");
  const formed = [...bracket.alliances].sort((a, b) => a.seed - b.seed);
  const rowCount = Math.max(selection?.alliances_target ?? 0, formed.length);
  const rows = Array.from({ length: rowCount }, (_, i) => {
    const alliance = formed[i];
    if (alliance) return { n: i + 1, captain: number(alliance.team_ids[0]), partner: number(alliance.team_ids[1]), pending: false, forming: false };
    const forming = selection !== null && i === formed.length;
    return {
      n: i + 1,
      captain: forming ? number(selection.captain_team_id) : "",
      partner: forming && selection.pending_team_id !== null ? number(selection.pending_team_id) : "",
      pending: forming && selection.pending_team_id !== null,
      forming,
    };
  });
  const available = selection
    ? [
        ...selection.invitable_team_ids.map((id) => ({ id, declined: false })),
        ...selection.declined_team_ids.map((id) => ({ id, declined: true })),
      ].sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity))
    : [];
  const pendingText =
    selection && selection.pending_team_id !== null
      ? t("display.pendingInvite", { captain: number(selection.captain_team_id), team: number(selection.pending_team_id) })
      : null;

  return (
    <ScreenFrame title={title} className="alliance-selection" context={undefined}>
      <div className="alliance-selection__banner">
        {pendingText && (
          <FitLine align="end" className="alliance-selection__pending" testId="pending-invite">
            {pendingText}
          </FitLine>
        )}
      </div>
      <div className="alliance-selection__body">
        <ol className="alliance-selection__alliances">
          {rows.map((row) => (
            <li
              key={row.n}
              className={`alliance-row${row.forming ? " is-forming" : ""}${row.pending ? " is-pending" : ""}`}
              data-testid={`alliance-row-${row.n}`}
            >
              <span className="alliance-row__number">{row.n}</span>
              <FitLine className="alliance-row__captain">{row.captain}</FitLine>
              <FitLine className="alliance-row__partner">
                {row.partner}
                {row.pending ? " ?" : ""}
              </FitLine>
            </li>
          ))}
        </ol>
        {selection && (
          <aside className="alliance-selection__available">
            <h2 className="alliance-selection__available-title">{t("display.available")}</h2>
            <ul>
              {available.map(({ id, declined }) => (
                <li
                  key={id}
                  className={`available-team${declined ? " is-declined" : ""}${id === selection.pending_team_id ? " is-pending" : ""}`}
                  data-testid={`available-team-${number(id)}`}
                >
                  <FitLine>{`#${ranks.get(id) ?? "–"} ${number(id)}`}</FitLine>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
    </ScreenFrame>
  );
}

export const allianceSelectionScreen: ScreenModule = {
  key: "alliance_selection",
  scrolls: false,
  Component: AllianceSelectionScreen,
};
