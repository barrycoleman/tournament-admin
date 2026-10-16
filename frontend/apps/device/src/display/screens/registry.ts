import { isScreenKey, type ScreenKey } from "@tournament-admin/shared";
import type { ScreenModule } from "../screenTypes";
import { inMatchScreen } from "./inMatch";
import { logoScreen } from "./logo";

/** One module per screen key. A key with no module here (an older device
 * app than the server) shows the Logo screen. */
const MODULES: Partial<Record<ScreenKey, ScreenModule>> = {
  in_match: inMatchScreen,
  logo: logoScreen,
};

export function screenModule(key: string | null): ScreenModule {
  return (isScreenKey(key) && MODULES[key]) || logoScreen;
}
