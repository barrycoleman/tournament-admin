import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { AllianceSelection, FieldRead, FieldSetRead, FinalsFormat } from "../types";
import { ROUND_CHOICES, type RoundChoice } from "./finalsPreview";

interface FinalsSettingsPanelProps {
  format: FinalsFormat;
  countText: string;
  onCountChange: (text: string) => void;
  onAllTeams: () => void;
  /** A sentence about the count: how many alliances it makes, or why it can't be used. */
  countSummary: string;
  countError: string | null;
  pairing: AllianceSelection;
  onPairingChange: (pairing: AllianceSelection) => void;
  fieldSets: FieldSetRead[];
  fieldSetId: number | null;
  onFieldSetChange: (fieldSetId: number) => void;
  fields: FieldRead[];
  tickedFieldIds: Set<number>;
  onFieldToggle: (fieldId: number, ticked: boolean) => void;
  roundKeys: string[];
  roundChoices: RoundChoice[];
  onRoundChoiceChange: (roundKey: string, choice: RoundChoice) => void;
  startLabel: string;
  startDisabled: boolean;
  starting: boolean;
  startError: string | null;
  onStart: () => void;
}

/** "roundOf16" reads "Round of 16"; the others have their own names. */
function useRoundName() {
  const { t } = useTranslation();
  return (key: string) =>
    key.startsWith("roundOf")
      ? t("sessions.finals.round.roundOf", { count: Number(key.slice("roundOf".length)) })
      : t(`sessions.finals.round.${key}`);
}

/** The set-up page's right side, top to bottom: team count, pairing, fields, games per round, start. */
export function FinalsSettingsPanel(props: FinalsSettingsPanelProps) {
  const { t } = useTranslation();
  const roundName = useRoundName();
  const countId = useId();
  const countHintId = useId();
  const headToHead = props.format === "single_elimination";

  return (
    <div className="panel finals-settings">
      <div className="field">
        <label className="field__label" htmlFor={countId}>
          {t("sessions.finals.teamCountLabel")}
        </label>
        <div className="finals-settings__count">
          <input
            id={countId}
            className="input"
            type="number"
            min={2}
            step={1}
            inputMode="numeric"
            value={props.countText}
            aria-describedby={countHintId}
            aria-invalid={props.countError ? true : undefined}
            onChange={(event) => props.onCountChange(event.target.value)}
          />
          <button type="button" className="btn btn-small" onClick={props.onAllTeams}>
            {t("sessions.finals.allTeams")}
          </button>
        </div>
        <p id={countHintId} className={props.countError ? "field__error" : "field__hint"}>
          {props.countError ?? props.countSummary}
        </p>
      </div>

      {headToHead && (
        <fieldset className="field finals-settings__group">
          <legend className="field__label">{t("sessions.finals.pairingLegend")}</legend>
          {(["captain_pick", "seed_pairing"] as const).map((value) => (
            <label key={value} className="choice">
              <input
                type="radio"
                name="finals-pairing"
                value={value}
                checked={props.pairing === value}
                onChange={() => props.onPairingChange(value)}
              />
              {t(`sessions.finals.pairing.${value}`)}
            </label>
          ))}
          <p className="field__hint">{t(`sessions.finals.pairingHint.${props.pairing}`)}</p>
        </fieldset>
      )}

      <fieldset className="field finals-settings__group">
        <legend className="field__label">{t("sessions.finals.fieldsLegend")}</legend>
        {props.fieldSets.length === 0 ? (
          <p className="field__hint">{t("sessions.finals.noFieldSets")}</p>
        ) : (
          <>
            {props.fieldSets.length > 1 && (
              <label className="field">
                <span className="field__label">{t("sessions.finals.fieldSetLabel")}</span>
                <select
                  className="select"
                  value={props.fieldSetId ?? ""}
                  onChange={(event) => props.onFieldSetChange(Number(event.target.value))}
                >
                  {props.fieldSets.map((fieldSet) => (
                    <option key={fieldSet.id} value={fieldSet.id}>
                      {fieldSet.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {props.fields.map((field) => (
              <label key={field.id} className="choice">
                <input
                  type="checkbox"
                  checked={props.tickedFieldIds.has(field.id)}
                  onChange={(event) => props.onFieldToggle(field.id, event.target.checked)}
                />
                {field.name}
              </label>
            ))}
            {props.fields.length > 0 && props.tickedFieldIds.size === 0 && (
              <p className="field__error">{t("sessions.finals.noFieldsTicked")}</p>
            )}
          </>
        )}
      </fieldset>

      {headToHead && props.roundKeys.length > 0 && (
        <fieldset className="field finals-settings__group">
          <legend className="field__label">{t("sessions.finals.gamesPerRoundLegend")}</legend>
          <div className="finals-settings__rounds">
            {props.roundKeys.map((key, index) => (
              <label key={key} className="finals-settings__round">
                <span>{roundName(key)}</span>
                <select
                  className="select"
                  value={props.roundChoices[index]}
                  onChange={(event) => props.onRoundChoiceChange(key, event.target.value as RoundChoice)}
                >
                  {ROUND_CHOICES.map((choice) => (
                    <option key={choice} value={choice}>
                      {t(`sessions.finals.roundChoice.${choice}`)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {props.startError && (
        <p className="alert alert-danger" role="alert">
          {props.startError}
        </p>
      )}
      <button
        type="button"
        className="btn btn-primary"
        disabled={props.startDisabled || props.starting}
        onClick={props.onStart}
      >
        {props.startLabel}
      </button>
    </div>
  );
}
