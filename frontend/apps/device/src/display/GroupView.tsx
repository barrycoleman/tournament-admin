import type { ScreenSettings } from "@tournament-admin/shared";
import { useFieldSets, type DisplayMe, type DisplayMeGroup } from "./api";
import type { ScreenContext } from "./screenTypes";
import { AudienceSounds } from "./AudienceSounds";
import { FieldDisplay } from "./FieldDisplay";
import { TimeoutGate } from "./components/TimeoutGate";
import { RotationRunner } from "./RotationRunner";
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
  const context = screenContext(sessionId, group, divisionId, group.screen_settings);
  if (group.kind === "pit" && group.rotation?.length) {
    const base = {
      sessionId: context.sessionId,
      fieldSetId: context.fieldSetId,
      divisionId: context.divisionId,
      queuedMatchId: context.queuedMatchId,
    };
    return <RotationRunner key={JSON.stringify(group.rotation)} entries={group.rotation} base={base} />;
  }
  const { Component } = screenModule(group.screen);
  if (group.kind !== "audience") return <Component context={context} />;
  return (
    <>
      <TimeoutGate deadline={timeoutDeadline}>
        <Component context={context} />
      </TimeoutGate>
      {group.play_sounds && (
        <AudienceSounds sessionId={sessionId} fieldSetId={group.field_set_id} timeoutDeadline={timeoutDeadline} />
      )}
    </>
  );
}
