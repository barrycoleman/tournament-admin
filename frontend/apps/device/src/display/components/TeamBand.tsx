import type { Team } from "../api";
import type { Side } from "../logic/sides";
import { FitText } from "./FitText";

/** A side-coloured block holding a side's team numbers, each fitted to its own cell. */
export function TeamBand({
  side,
  teamIds,
  teams,
  orientation,
}: {
  side: Side;
  teamIds: number[];
  teams: Map<number, Team>;
  orientation: "row" | "fill";
}) {
  return (
    <div className={`team-band team-band--${side} team-band--${orientation}`} data-testid={`band-${side}`}>
      {teamIds.map((id) => (
        <div key={id} className="team-band__cell">
          <FitText testId={`band-number-${id}`}>{teams.get(id)?.number ?? ""}</FitText>
        </div>
      ))}
    </div>
  );
}
