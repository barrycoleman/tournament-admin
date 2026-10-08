export type ScoresheetDataType = "integer" | "boolean" | "enum";
export type ScoresheetWidget = "counter" | "toggle" | "select" | "radio";
export type ScoresheetValue = number | boolean | string;
export type ScoresheetValues = Record<string, ScoresheetValue>;

/** One field of a game plugin's scoresheet schema (teamwork or skills), as the server returns it. */
export interface ScoresheetField {
  name: string;
  label: string;
  data_type: ScoresheetDataType;
  widget: ScoresheetWidget;
  min: number | null;
  max: number | null;
  step: number | null;
  options: (string | number)[] | null;
  icon: string | null;
  scope: string;
  default: ScoresheetValue;
}

/** The caller's translate function. The form's own strings use keys under `scoresheet.`. */
export type ScoresheetTranslate = (key: string, options?: Record<string, unknown>) => string;

export function defaultValues(fields: ScoresheetField[]): ScoresheetValues {
  return Object.fromEntries(fields.map((field) => [field.name, field.default]));
}

export function clampCounter(field: ScoresheetField, value: number): number {
  let next = value;
  if (field.min !== null && next < field.min) next = field.min;
  if (field.max !== null && next > field.max) next = field.max;
  return next;
}
