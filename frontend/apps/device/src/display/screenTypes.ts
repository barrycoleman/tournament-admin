import type { ComponentType } from "react";
import type { ScreenKey, ScreenSettings } from "@tournament-admin/shared";

/** What a screen needs to know about where it is showing. */
export interface ScreenContext {
  sessionId: number;
  /** The audience group's field set; null on a pit group. */
  fieldSetId: number | null;
  /** The field set's or pit group's division; null for "every division". */
  divisionId: number | null;
  settings: ScreenSettings;
  queuedMatchId: number | null;
}

export interface ScreenProps {
  context: ScreenContext;
  /** In a rotation: a scrolling screen calls this once it has shown its whole list. */
  onDone?: () => void;
  /** In a rotation: how long a scrolling screen whose list fits stays up, in seconds. */
  fitSeconds?: number;
}

export interface ScreenModule {
  key: ScreenKey;
  scrolls: boolean;
  Component: ComponentType<ScreenProps>;
}
