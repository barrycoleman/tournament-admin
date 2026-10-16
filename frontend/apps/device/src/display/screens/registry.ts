import { isScreenKey, type ScreenKey } from "@tournament-admin/shared";
import type { ScreenModule } from "../screenTypes";
import { inMatchScreen } from "./inMatch";
import { lastScoredMatchScreen } from "./lastScoredMatch";
import { logoScreen } from "./logo";
import { matchIntroScreen } from "./matchIntro";

/** One module per screen key. A key with no module here (an older device
 * app than the server) shows the Logo screen. */
const MODULES: Partial<Record<ScreenKey, ScreenModule>> = {
  match_intro: matchIntroScreen,
  in_match: inMatchScreen,
  last_scored_match: lastScoredMatchScreen,
  logo: logoScreen,
};

export function screenModule(key: string | null): ScreenModule {
  return (isScreenKey(key) && MODULES[key]) || logoScreen;
}
