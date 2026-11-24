import { useCallback, useState } from "react";

export type OperatorSoundPage = "matchControl" | "skillsControl";

const keyOf = (page: OperatorSoundPage) => `tm.operatorSounds.${page}`;

function read(page: OperatorSoundPage): boolean {
  try {
    return localStorage.getItem(keyOf(page)) === "1";
  } catch {
    return false;
  }
}

/** Whether this browser plays the cue sounds on an operator page; kept in
 * this browser only, off until someone turns it on. */
export function useOperatorSoundSetting(page: OperatorSoundPage): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => read(page));
  const set = useCallback(
    (next: boolean) => {
      setOn(next);
      try {
        localStorage.setItem(keyOf(page), next ? "1" : "0");
      } catch {
        // Storage may be blocked; the switch still works until the page closes.
      }
    },
    [page]
  );
  return [on, set];
}
