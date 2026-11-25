import { useAllDivisionsFinals, useEventInfo, type FinalsBracket } from "../display/api";

/** The active session's newest bracket, in any division, that is still
 * choosing alliances; null when there is none (no active session, no
 * brackets, or all started), undefined while loading. */
export function useSelectingFinals(): FinalsBracket | null | undefined {
  const event = useEventInfo();
  const sessionId = event.data?.active_session_id ?? null;
  const finals = useAllDivisionsFinals(sessionId);
  if (!event.data) return undefined;
  if (sessionId === null) return null;
  if (!finals.data) return undefined;
  return [...finals.data].sort((a, b) => b.id - a.id).find((b) => b.status === "selecting_alliances") ?? null;
}
