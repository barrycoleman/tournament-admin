import { useTranslation } from "react-i18next";
import type { LiveMatch } from "@tournament-admin/shared";
import type { GameModel, Team } from "../api";
import { groupScore, scoreGroups, sideGroups, teamPlace } from "../logic/sides";

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
  const groups = scoreGroups(match, gameModel);
  const sideScore = (side: string) => {
    const group = groups.find((g) => g.side === side) ?? groups.find((g) => g.side === "combined");
    return scores && group ? groupScore(group, scores) : null;
  };
  return (
    <div className="bands">
      {sideGroups(match, ranks).map((group) => (
        <section key={group.side} className={`band band--${group.side}`} aria-label={t(`display.alliance.${group.side}`)}>
          <h2 className="band__label">{t(`display.alliance.${group.side}`)}</h2>
          {scores && (
            <p className="band__score" data-testid={`score-${group.side}`}>
              {sideScore(group.side) ?? "–"}
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
