import type { ScreenSettings } from "@tournament-admin/shared";
import { useFieldSets, type DisplayMe, type DisplayMeGroup } from "./api";
import type { ScreenContext } from "./screenTypes";
import { FieldDisplay } from "./FieldDisplay";
import { TimeoutGate } from "./components/TimeoutGate";
import { screenModule } from "./screens/registry";

export function screenContext(
  sessionId: number,
  group: DisplayMeGroup,
  divisionId: number | null,
  settings: ScreenSettings
): ScreenContext {
  return {
    sessionId,
    fieldSetId: group.kind === "pit" ? null : group.field_set_id,
    divisionId,
    settings,
    queuedMatchId: group.field_set?.queued_match_id ?? null,
  };
}

/** Mounts what a display's group shows. */
export function GroupView({ me }: { me: DisplayMe & { session_id: number; group: DisplayMeGroup } }) {
  const { group, session_id: sessionId } = me;
  const fieldSets = useFieldSets(sessionId);
  const timeoutDeadline = group.field_set?.timeout_deadline ?? null;
  if (group.kind === "field" && group.field_id !== null) {
    return (
      <TimeoutGate deadline={timeoutDeadline}>
        <FieldDisplay sessionId={sessionId} fieldId={group.field_id} />
      </TimeoutGate>
    );
  }
  const divisionId =
    group.kind === "pit"
      ? group.division_id
      : fieldSets.data?.find((fs) => fs.id === group.field_set_id)?.division_id ?? null;
  // Pit rotations get the runner in Task 12.
  const entry = group.kind === "pit" && group.rotation?.length ? group.rotation[0] : null;
  const { Component } = screenModule(entry ? entry.screen : group.screen);
  const screen = (
    <Component context={screenContext(sessionId, group, divisionId, entry ? entry.settings : group.screen_settings)} />
  );
  return group.kind === "audience" ? <TimeoutGate deadline={timeoutDeadline}>{screen}</TimeoutGate> : screen;
}
