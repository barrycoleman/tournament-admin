import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Cue, FlashKind } from "@tournament-admin/shared";
import { useFollowedCues, type Follows } from "../useCueStream";
import { FitLine } from "./FitText";

/** How long the border pulses (twice) and the banner stays. */
export const FLASH_BORDER_MS = 1_500;
export const FLASH_BANNER_MS = 2_000;

interface Showing {
  id: number;
  kind: FlashKind;
  label: string | null;
  border: boolean;
}

let nextId = 1;

/** Set on the display root while a flash shows, so the live totals rise
 * above the banner only then. */
export const FLASHING_CLASS = "display--flashing";

/** The flash on a TV showing a running timer: a border pulsing round the whole
 * screen and a banner naming the moment, over the bottom bar on a match TV and
 * over the title band on a skills TV (whose scores sit at the bottom). Mounted
 * beside the screen, not in it, so a reset's red banner stays while the screen
 * changes under it. Independent of the TV's sound switch. */
export function CueFlash({ sessionId, follows }: { sessionId: number; follows: Follows }) {
  const { t } = useTranslation();
  const [showing, setShowing] = useState<Showing | null>(null);

  const onCues = useCallback((cues: Cue[]) => {
    // The last flash of a batch wins, and a new flash replaces the current one.
    const flash = cues.reduce<Cue["flash"]>((last, cue) => cue.flash ?? last, null);
    if (flash) setShowing({ id: nextId++, kind: flash.kind, label: flash.label, border: true });
  }, []);
  useFollowedCues(sessionId, follows, onCues);

  const id = showing?.id;
  useEffect(() => {
    if (id === undefined) return;
    const border = setTimeout(
      () => setShowing((now) => (now?.id === id ? { ...now, border: false } : now)),
      FLASH_BORDER_MS
    );
    const banner = setTimeout(() => setShowing((now) => (now?.id === id ? null : now)), FLASH_BANNER_MS);
    return () => {
      clearTimeout(border);
      clearTimeout(banner);
    };
  }, [id]);

  const root = useRef<HTMLDivElement>(null);
  const flashing = showing !== null;
  useEffect(() => {
    const display = flashing ? root.current?.closest(".display") : null;
    if (!display) return;
    display.classList.add(FLASHING_CLASS);
    return () => display.classList.remove(FLASHING_CLASS);
  }, [flashing]);

  if (!showing) return null;
  const skills = follows.kind === "skillsSet" || follows.kind === "skillsField";
  let text = showing.label ?? "";
  if (showing.label === null && showing.kind === "over") text = t(skills ? "display.cue.time" : "display.cue.matchOver");
  if (showing.label === null && showing.kind === "stop") text = t(skills ? "display.cue.stopped" : "display.cue.matchStopped");
  return (
    <div
      key={showing.id}
      ref={root}
      className={`cue-flash cue-flash--${showing.kind} ${skills ? "cue-flash--top" : "cue-flash--bottom"}`}
      data-testid="cue-flash"
      data-kind={showing.kind}
      role="status"
    >
      {showing.border && <div className="cue-flash__border" aria-hidden="true" />}
      <div className="cue-flash__banner">
        <FitLine className="cue-flash__text">{text}</FitLine>
      </div>
    </div>
  );
}
