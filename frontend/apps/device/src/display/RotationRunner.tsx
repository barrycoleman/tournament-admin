import { useCallback, useEffect, useState } from "react";
import type { RotationEntry } from "@tournament-admin/shared";
import type { ScreenContext } from "./screenTypes";
import { screenModule } from "./screens/registry";

/** Shows each rotation entry in turn. A scrolling screen moves on once it has
 * shown its whole list (or, when it fits, after the entry's seconds); any
 * other screen after the entry's seconds. */
export function RotationRunner({ entries, base }: { entries: RotationEntry[]; base: Omit<ScreenContext, "settings"> }) {
  const [step, setStep] = useState(0);
  const entry = entries[step % entries.length];
  const module = screenModule(entry.screen);
  const next = useCallback(() => setStep((n) => n + 1), []);
  useEffect(() => {
    if (module.scrolls) return undefined;
    const id = setTimeout(next, entry.seconds * 1000);
    return () => clearTimeout(id);
  }, [step, module.scrolls, entry.seconds, next]);
  const { Component } = module;
  return (
    <Component
      key={step}
      context={{ ...base, settings: entry.settings }}
      onDone={module.scrolls ? next : undefined}
      fitSeconds={entry.seconds}
    />
  );
}
