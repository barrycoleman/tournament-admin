import { useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Division } from "../types";

interface DivisionTabsProps {
  divisions: Division[];
  /** Checked-in team count per division id. */
  counts: Map<number, number>;
  selectedId: number;
  onSelect: (divisionId: number) => void;
}

/** A tab per division; arrow keys, Home and End move between them. */
export function DivisionTabs({ divisions, counts, selectedId, onSelect }: DivisionTabsProps) {
  const { t } = useTranslation();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = divisions.findIndex((division) => division.id === selectedId);
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % divisions.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + divisions.length) % divisions.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = divisions.length - 1;
    else return;
    event.preventDefault();
    onSelect(divisions[next].id);
    refs.current[next]?.focus();
  }

  return (
    <div className="division-tabs" role="tablist" aria-label={t("sessions.schedule.divisionTabsLabel")} onKeyDown={onKeyDown}>
      {divisions.map((division, index) => {
        const selected = division.id === selectedId;
        return (
          <button
            key={division.id}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`division-tab-${division.id}`}
            aria-selected={selected}
            aria-controls="division-panel"
            tabIndex={selected ? 0 : -1}
            className="division-tabs__tab"
            onClick={() => onSelect(division.id)}
          >
            {t("sessions.schedule.divisionTab", { name: division.name, count: counts.get(division.id) ?? 0 })}
          </button>
        );
      })}
    </div>
  );
}
