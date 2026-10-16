import type { ScreenSettings } from "@tournament-admin/shared";
import { useFieldSets, type DisplayMe, type DisplayMeGroup } from "./api";
import type { ScreenContext } from "./screenTypes";
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
  const divisionId =
    group.kind === "pit"
      ? group.division_id
      : fieldSets.data?.find((fs) => fs.id === group.field_set_id)?.division_id ?? null;
  // Field groups get the field display in Task 8; pit rotations get the runner in Task 12.
  const entry = group.kind === "pit" && group.rotation?.length ? group.rotation[0] : null;
  const key = group.kind === "field" ? "logo" : entry ? entry.screen : group.screen;
  const settings = entry ? entry.settings : group.screen_settings;
  const { Component } = screenModule(key);
  return <Component context={screenContext(sessionId, group, divisionId, settings)} />;
}
