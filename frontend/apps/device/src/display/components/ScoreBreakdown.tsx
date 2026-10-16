import { useTranslation } from "react-i18next";
import type { LiveMatch } from "@tournament-admin/shared";
import type { GameModel, ScoresheetFieldInfo } from "../api";
import { allianceGroups } from "../logic/alliances";

export function formatSheetValue(value: unknown): string {
  if (value === true) return "✓";
  if (value === false || value === null || value === undefined || value === "") return "–";
  return String(value);
}

/** One row per scoresheet field, one column per alliance band. */
export function ScoreBreakdown({
  match,
  gameModel,
  schema,
  sheets,
}: {
  match: LiveMatch;
  gameModel: GameModel;
  schema: ScoresheetFieldInfo[];
  sheets: Map<number, Record<string, unknown>>;
}) {
  const { t } = useTranslation();
  const columns = allianceGroups(match, gameModel).map((group) => ({
    station: group.station,
    sheet: group.allianceIds.map((id) => sheets.get(id)).find((s) => s !== undefined) ?? {},
  }));
  return (
    <table className="breakdown" aria-label={t("display.breakdown")}>
      <tbody>
        {schema.map((field) => (
          <tr key={field.name}>
            <th scope="row">{field.label}</th>
            {columns.map((column) => (
              <td key={column.station} className={`breakdown__value breakdown__value--${column.station}`}>
                {formatSheetValue(column.sheet[field.name])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
