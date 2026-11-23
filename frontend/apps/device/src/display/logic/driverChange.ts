// The in-match cues slice will move these into game-plugin data.
export const DRIVER_CHANGE_STARTS_AT = 35;
export const DRIVER_CHANGE_ENDS_AT = 25;

/** True during the driver-change window: the driver period, 35 s down to (not
 * including) 25 s remaining, and only for a driver period longer than 35 s. */
export function inDriverChange(phase: string, remaining: number, driverSeconds: number): boolean {
  return (
    phase === "driver" &&
    driverSeconds > DRIVER_CHANGE_STARTS_AT &&
    remaining > DRIVER_CHANGE_ENDS_AT &&
    remaining <= DRIVER_CHANGE_STARTS_AT
  );
}
