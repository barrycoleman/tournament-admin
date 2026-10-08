import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TeamSummary } from "../types";
import { matchTeams } from "./recordForm";

/** A searchable list of the session's checked-in teams, matched by number or name. */
export function TeamPicker({
  teams,
  selectedId,
  onSelect,
}: {
  teams: TeamSummary[];
  selectedId: number | null;
  onSelect: (teamId: number | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [text, setText] = useState("");
  const selected = teams.find((team) => team.id === selectedId) ?? null;

  if (selected) {
    return (
      <div className="field">
        <span className="field__label">{t("skills.record.teamLabel")}</span>
        <p className="team-picker__selected">
          <strong>{selected.number}</strong> {selected.name}{" "}
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              setText("");
              onSelect(null);
            }}
          >
            {t("skills.record.changeTeam")}
          </button>
        </p>
      </div>
    );
  }

  const matches = matchTeams(teams, text);
  return (
    <div className="field team-picker">
      <label className="field__label" htmlFor={id}>
        {t("skills.record.teamLabel")}
      </label>
      <input
        id={id}
        className="input"
        role="combobox"
        aria-expanded={matches.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        placeholder={t("skills.record.teamPlaceholder")}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <ul id={`${id}-list`} role="listbox" className="team-picker__list" aria-label={t("skills.record.teamLabel")}>
        {matches.map((team) => (
          <li
            key={team.id}
            role="option"
            aria-selected={false}
            tabIndex={0}
            onClick={() => onSelect(team.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(team.id);
              }
            }}
          >
            {team.number} {team.name}
          </li>
        ))}
      </ul>
      {matches.length === 0 && <p className="field__hint">{t("skills.record.noTeams")}</p>}
    </div>
  );
}
