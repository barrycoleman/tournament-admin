import { useTranslation } from "react-i18next";
import type { SkillsType } from "../types";

interface AttemptsInputsProps {
  /** One input per type, in this order. */
  types: SkillsType[];
  /** Type key -> the text in its box. */
  values: Record<string, string>;
  /** Type keys to show the inline error on (callers pass them only once the user has tried to save). */
  invalidKeys: ReadonlySet<string>;
  onChange: (key: string, text: string) => void;
  /** Makes element ids unique when two sets of inputs share a page. */
  idPrefix?: string;
}

/** One labelled attempts-per-session number input per skills type, with an inline error. */
export function AttemptsInputs({ types, values, invalidKeys, onChange, idPrefix = "skills-attempts" }: AttemptsInputsProps) {
  const { t } = useTranslation();
  return (
    <>
      {types.map((type) => {
        const inputId = `${idPrefix}-${type.key}`;
        const invalid = invalidKeys.has(type.key);
        return (
          <div className="field" key={type.key}>
            <label className="field__label" htmlFor={inputId}>
              {t("skills.settings.attemptsLabel", { label: type.label })}
            </label>
            <input
              id={inputId}
              className="input settings-number"
              inputMode="numeric"
              value={values[type.key] ?? ""}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={invalid ? `${inputId}-error` : undefined}
              onChange={(changeEvent) => onChange(type.key, changeEvent.target.value)}
            />
            {invalid && (
              <p className="field__hint field__error" id={`${inputId}-error`}>
                {t("skills.settings.attemptsError")}
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}
