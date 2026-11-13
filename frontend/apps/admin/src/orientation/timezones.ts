/** IANA zone names the browser knows, plus `extra` when the list lacks it (some browsers omit "UTC"). */
export function listTimezones(extra?: string): string[] {
  const intlWithZones = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  const zones = intlWithZones.supportedValuesOf?.("timeZone") ?? [];
  return extra && !zones.includes(extra) ? [extra, ...zones] : zones;
}
