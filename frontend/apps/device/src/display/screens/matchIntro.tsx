import { useTranslation } from "react-i18next";
import { nextMatchForFieldSet } from "@tournament-admin/shared";
import { useFields, useMatchFormat, useMatches, useRanks, useTeamsById } from "../api";
import { FitText } from "../components/FitText";
import { BottomBar, MatchFrame } from "../components/MatchFrame";
import { ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { StartCountdown } from "../components/StartCountdown";
import { sideGroups, teamPlace } from "../logic/sides";
import { matchTitle } from "../matchTitle";
import type { ScreenModule, ScreenProps } from "../screenTypes";
import { useServerNow } from "../serverClock";
import { fieldIdsOf } from "./inMatch";

function MatchIntroScreen({ context }: ScreenProps) {
  const { t } = useTranslation();
  const now = useServerNow();
  const matches = useMatches(context.sessionId);
  const fields = useFields(context.sessionId);
  const format = useMatchFormat();
  const teams = useTeamsById();
  const next =
    matches.data && fields.data
      ? nextMatchForFieldSet(matches.data, fieldIdsOf(fields.data, context.fieldSetId), context.queuedMatchId)
      : null;
  const ranks = useRanks(context.sessionId, next?.division_id ?? context.divisionId);
  const title = t("display.screens.match_intro");
  if (!matches.data || !fields.data || !format.data || !teams) return <WaitingForData title={title} />;
  if (!next) return <ScreenNotice title={title} text={t("display.noMoreMatches")} />;
  const fieldName = fields.data.find((f) => f.id === next.field_id)?.name;
  return (
    <MatchFrame
      className="intro"
      bottom={
        <BottomBar
          prefix={t("display.upNextPrefix")}
          title={matchTitle(t, next)}
          field={fieldName}
          end={<StartCountdown scheduledTime={next.scheduled_time} now={now} />}
        />
      }
    >
      {sideGroups(next, ranks).map((group) => (
        <section
          key={group.side}
          className={`intro__side intro__side--${group.side}`}
          data-testid={`intro-${group.side}`}
          aria-label={t(`display.alliance.${group.side}`)}
        >
          {group.teamIds.map((id) => {
            const team = teams.get(id);
            const rank = ranks?.get(id);
            return (
              <div key={id} className="intro-team" data-testid={`intro-team-${id}`}>
                <span className="intro-team__rank" data-testid={`rank-${id}`}>
                  {rank === undefined ? "–" : `#${rank}`}
                </span>
                <span className="intro-team__number">
                  <FitText testId={`intro-number-${id}`}>{team?.number ?? ""}</FitText>
                </span>
                <span className="intro-team__name">{team?.name ?? ""}</span>
                <span className="intro-team__place">{teamPlace(team)}</span>
              </div>
            );
          })}
        </section>
      ))}
    </MatchFrame>
  );
}

export const matchIntroScreen: ScreenModule = { key: "match_intro", scrolls: false, Component: MatchIntroScreen };
