import type { ComponentType } from "react";
import {
  clampCounter,
  type ScoresheetField,
  type ScoresheetTranslate,
  type ScoresheetValue,
  type ScoresheetValues,
  type ScoresheetWidget,
} from "./types";

interface FieldProps {
  field: ScoresheetField;
  value: ScoresheetValue | undefined;
  onChange: (value: ScoresheetValue) => void;
  id: string;
  errorId: string | undefined;
  t: ScoresheetTranslate;
}

function Icon({ icon }: { icon: string | null }) {
  return icon ? (
    <span className="scoresheet__icon" aria-hidden="true">
      {icon}
    </span>
  ) : null;
}

/** − value +. The buttons clamp to min/max; a typed number is passed through as typed so the server can report it. */
function CounterField({ field, value, onChange, id, errorId, t }: FieldProps) {
  const numeric = typeof value === "number" ? value : null;
  const step = field.step ?? 1;
  const bump = (delta: number) => onChange(clampCounter(field, (numeric ?? field.min ?? 0) + delta));
  return (
    <div className="scoresheet__field">
      <label className="scoresheet__label" htmlFor={id}>
        <Icon icon={field.icon} />
        {field.label}
      </label>
      <div className="scoresheet__counter">
        <button
          type="button"
          className="btn"
          aria-label={t("scoresheet.decrease", { label: field.label })}
          disabled={numeric !== null && field.min !== null && numeric <= field.min}
          onClick={() => bump(-step)}
        >
          −
        </button>
        <input
          id={id}
          className="input scoresheet__count"
          inputMode="numeric"
          value={value === undefined ? "" : String(value)}
          aria-invalid={errorId ? true : undefined}
          aria-describedby={errorId}
          onChange={(event) => {
            const text = event.target.value.trim();
            onChange(/^-?\d+$/.test(text) ? Number(text) : text);
          }}
        />
        <button
          type="button"
          className="btn"
          aria-label={t("scoresheet.increase", { label: field.label })}
          disabled={numeric !== null && field.max !== null && numeric >= field.max}
          onClick={() => bump(step)}
        >
          +
        </button>
      </div>
    </div>
  );
}

function ToggleField({ field, value, onChange, id, errorId }: FieldProps) {
  return (
    <div className="scoresheet__field">
      <label className="choice">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={value === true}
          aria-invalid={errorId ? true : undefined}
          aria-describedby={errorId}
          onChange={(event) => onChange(event.target.checked)}
        />
        <Icon icon={field.icon} />
        {field.label}
      </label>
    </div>
  );
}

function optionFor(field: ScoresheetField, text: string): ScoresheetValue {
  return (field.options ?? []).find((option) => String(option) === text) ?? text;
}

function SelectField({ field, value, onChange, id, errorId }: FieldProps) {
  const options = field.options ?? [];
  const hasChoice = value !== undefined && options.some((option) => String(option) === String(value));
  return (
    <div className="scoresheet__field">
      <label className="scoresheet__label" htmlFor={id}>
        <Icon icon={field.icon} />
        {field.label}
      </label>
      <select
        id={id}
        className="input select"
        value={hasChoice ? String(value) : ""}
        aria-invalid={errorId ? true : undefined}
        aria-describedby={errorId}
        onChange={(event) => onChange(optionFor(field, event.target.value))}
      >
        {/* Without this the browser would show the first option while the state stays unset. */}
        {!hasChoice && (
          <option value="" disabled>
            {"—"}
          </option>
        )}
        {options.map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    </div>
  );
}

function RadioField({ field, value, onChange, id, errorId }: FieldProps) {
  return (
    <fieldset className="scoresheet__field scoresheet__radio" aria-describedby={errorId}>
      <legend className="scoresheet__label">
        <Icon icon={field.icon} />
        {field.label}
      </legend>
      {(field.options ?? []).map((option) => (
        <label className="choice" key={String(option)}>
          <input type="radio" name={id} checked={value === option} onChange={() => onChange(option)} />
          {String(option)}
        </label>
      ))}
    </fieldset>
  );
}

const WIDGETS: Record<ScoresheetWidget, ComponentType<FieldProps>> = {
  counter: CounterField,
  toggle: ToggleField,
  select: SelectField,
  radio: RadioField,
};

export interface ScoresheetFormProps {
  fields: ScoresheetField[];
  values: ScoresheetValues;
  onChange: (values: ScoresheetValues) => void;
  /** Field name -> message, shown beside that field. */
  errors?: Record<string, string>;
  t: ScoresheetTranslate;
  idPrefix: string;
}

/** A plugin scoresheet drawn from its field list. Knows nothing about skills or teamwork. */
export function ScoresheetForm({ fields, values, onChange, errors = {}, t, idPrefix }: ScoresheetFormProps) {
  return (
    <div className="scoresheet">
      {fields.map((field) => {
        const id = `${idPrefix}-${field.name}`;
        const error = errors[field.name];
        const errorId = error ? `${id}-error` : undefined;
        const Widget = WIDGETS[field.widget];
        return (
          <div key={field.name} className="scoresheet__row">
            <Widget
              field={field}
              value={values[field.name]}
              id={id}
              errorId={errorId}
              t={t}
              onChange={(value) => onChange({ ...values, [field.name]: value })}
            />
            {error && (
              <p className="field__hint field__error" id={errorId}>
                {error}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
