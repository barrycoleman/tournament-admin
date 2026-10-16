import { isScreenKey, type ScreenKey } from "@tournament-admin/shared";
import type { ScreenModule } from "../screenTypes";
import { eliminationBracketScreen } from "./eliminationBracket";
import { inMatchScreen } from "./inMatch";
import { lastScoredMatchScreen } from "./lastScoredMatch";
import { logoScreen } from "./logo";
import { matchIntroScreen } from "./matchIntro";
import { matchResultsScreen } from "./matchResults";
import { scheduleScreen } from "./schedule";
import { skillsRankingsScreen } from "./skillsRankings";
import { teamworkRankingsScreen } from "./teamworkRankings";
import { upcomingMatchesScreen } from "./upcomingMatches";

/** One module per screen key. A key with no module here (an older device
 * app than the server) shows the Logo screen. */
const MODULES: Partial<Record<ScreenKey, ScreenModule>> = {
  match_intro: matchIntroScreen,
  in_match: inMatchScreen,
  last_scored_match: lastScoredMatchScreen,
  teamwork_rankings: teamworkRankingsScreen,
  skills_rankings: skillsRankingsScreen,
  upcoming_matches: upcomingMatchesScreen,
  match_results: matchResultsScreen,
  schedule: scheduleScreen,
  elimination_bracket: eliminationBracketScreen,
  logo: logoScreen,
};

export function screenModule(key: string | null): ScreenModule {
  return (isScreenKey(key) && MODULES[key]) || logoScreen;
}
