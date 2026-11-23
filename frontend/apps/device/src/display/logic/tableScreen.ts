import type { ScreenContext } from "../screenTypes";

/** Table screens size for where they show: a pit group (no field set) is read close up, so it fits more, smaller rows. */
export function tableScreenClass(context: ScreenContext): string {
  return `table-screen ${context.fieldSetId === null ? "table-screen--pit" : "table-screen--audience"}`;
}
