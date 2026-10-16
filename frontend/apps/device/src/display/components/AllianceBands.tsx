import { useTranslation } from "react-i18next";
import type { LiveMatch } from "@tournament-admin/shared";
import type { GameModel, Team } from "../api";
import { allianceGroups, groupScore, teamPlace } from "../logic/alliances";

export function AllianceBands({
  match,
  gameModel,
  teams,
  ranks,
  scores,
}: {
  match: LiveMatch;
  gameModel: GameModel;
  teams: Map<number, Team>;
  ranks: Map<number, number> | undefined;
  scores?: Map<number, number>;
}) {
  const { t } = useTranslation();
  return (
    <div className="bands">
      {allianceGroups(match, gameModel).map((group) => (
        <section key={group.station} className={`band band--${group.station}`} aria-label={t(`display.alliance.${group.station}`)}>
          <h2 className="band__label">{t(`display.alliance.${group.station}`)}</h2>
          {scores && (
            <p className="band__score" data-testid={`score-${group.station}`}>
              {groupScore(group, scores) ?? "–"}
            </p>
          )}
          <ul className="band__teams">
            {group.teamIds.map((id) => {
              const team = teams.get(id);
              return (
                <li key={id} className="band__team">
                  <span className="band__rank" data-testid={`rank-${id}`}>
                    {ranks?.get(id) ?? "–"}
                  </span>
                  <span className="band__number">{team?.number ?? ""}</span>
                  <span className="band__name">{team?.name ?? ""}</span>
                  <span className="band__place">{teamPlace(team)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
