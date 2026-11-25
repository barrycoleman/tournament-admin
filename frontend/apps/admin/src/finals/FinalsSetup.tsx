import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiErrorMessage } from "../apiErrorMessage";
import type { AllianceSelection, FinalsFormat, RankingRead, SessionRead } from "../types";
import { FinalsRankingsTable, type FinalsRankingRow } from "./FinalsRankingsTable";
import { FinalsSettingsPanel } from "./FinalsSettingsPanel";
import {
  allianceCount,
  finalsColumn,
  roundLabels,
  winsToAdvance,
  type FinalsMode,
  type RoundChoice,
} from "./finalsPreview";
import {
  useExclusionMutations,
  useFinalsExclusions,
  useFinalsSetupData,
  useMatchFormat,
  useStartFinals,
  type FinalsScope,
  type StartFinalsBody,
} from "./useFinals";

interface FinalsSetupProps {
  session: SessionRead;
  divisionId: number | null;
  rankings: RankingRead[];
}

/** The usual size: 16 teams (8 alliances), or fewer when fewer can go. */
const DEFAULT_TEAM_COUNT = 16;

function modeFor(format: FinalsFormat, pairing: AllianceSelection): FinalsMode {
  if (format === "score_chase") return "score_chase";
  return pairing === "captain_pick" ? "picking" : "pairs_knockout";
}

/** Finals set-up for one session + division: rankings with exclusions on the left, settings on the right. */
export function FinalsSetup({ session, divisionId, rankings }: FinalsSetupProps) {
  const { t } = useTranslation();
  const scope: FinalsScope = { sessionId: session.id, divisionId };
  const matchFormat = useMatchFormat();
  const exclusionsQuery = useFinalsExclusions(scope);
  const { teams, fieldSets, fields } = useFinalsSetupData(session.id);
  const { exclude, undo } = useExclusionMutations(scope);
  const start = useStartFinals(scope);

  const [pairingChoice, setPairingChoice] = useState<AllianceSelection | null>(null);
  const [countText, setCountText] = useState<string | null>(null);
  const [chosenFieldSetId, setChosenFieldSetId] = useState<number | null>(null);
  const [untickedFieldIds, setUntickedFieldIds] = useState<Set<number>>(new Set());
  const [roundOverrides, setRoundOverrides] = useState<Record<string, RoundChoice>>({});

  const format: FinalsFormat = matchFormat.data?.finals_format ?? "single_elimination";
  const pairing: AllianceSelection =
    format === "score_chase" ? "seed_pairing" : (pairingChoice ?? matchFormat.data?.alliance_selection ?? "captain_pick");
  const mode = modeFor(format, pairing);

  const exclusions = useMemo(() => exclusionsQuery.data ?? [], [exclusionsQuery.data]);
  const rankedIds = useMemo(
    () => [...rankings].sort((a, b) => a.rank - b.rank).map((row) => row.team_id),
    [rankings]
  );
  const excludedIds = useMemo(() => new Set(exclusions.map((row) => row.team_id)), [exclusions]);
  const eligibleCount = rankedIds.filter((teamId) => !excludedIds.has(teamId)).length;

  const defaultCount =
    mode === "score_chase" ? eligibleCount : Math.min(DEFAULT_TEAM_COUNT, eligibleCount - (eligibleCount % 2));
  const shownCountText = countText ?? String(defaultCount);
  const parsedCount = /^\d+$/.test(shownCountText.trim()) ? Number(shownCountText.trim()) : null;

  let countError: string | null = null;
  if (parsedCount === null) countError = t("sessions.finals.countWholeNumber");
  else if (parsedCount > eligibleCount) countError = t("sessions.finals.countTooMany", { count: eligibleCount });
  else if (mode === "picking" && parsedCount % 2 === 1) countError = t("sessions.finals.countOddPicking");
  else if (allianceCount(parsedCount, mode) < 2) countError = t("sessions.finals.countTooFew");
  const previewCount = parsedCount === null ? 0 : Math.min(parsedCount, eligibleCount);
  const alliances = allianceCount(previewCount, mode);

  const column = useMemo(
    () => finalsColumn(rankedIds, excludedIds, previewCount, mode),
    [rankedIds, excludedIds, previewCount, mode]
  );
  const teamById = useMemo(() => new Map((teams ?? []).map((team) => [team.id, team])), [teams]);
  const exclusionByTeam = useMemo(() => new Map(exclusions.map((row) => [row.team_id, row])), [exclusions]);
  const rankByTeam = useMemo(() => new Map(rankings.map((row) => [row.team_id, row.rank])), [rankings]);
  const rows: FinalsRankingRow[] = rankedIds.map((teamId) => ({
    teamId,
    rank: rankByTeam.get(teamId) ?? 0,
    team: teamById.get(teamId),
    cell: column.get(teamId),
    exclusion: exclusionByTeam.get(teamId),
  }));
  const cutAfterTeamId =
    mode === "picking" ? null : ([...rankedIds].reverse().find((teamId) => column.get(teamId)?.kind === "alliance") ?? null);

  const divisionFieldSets = (fieldSets ?? []).filter(
    (fieldSet) => fieldSet.purpose === "teamwork" && fieldSet.division_id === divisionId
  );
  const fieldSetId =
    divisionFieldSets.find((fieldSet) => fieldSet.id === chosenFieldSetId)?.id ?? divisionFieldSets[0]?.id ?? null;
  const setFields = (fields ?? []).filter((field) => field.field_set_id === fieldSetId);
  const tickedFieldIds = new Set(setFields.filter((field) => !untickedFieldIds.has(field.id)).map((field) => field.id));

  const roundKeys = format === "single_elimination" ? roundLabels(alliances) : [];
  const roundChoices = roundKeys.map(
    (key): RoundChoice => roundOverrides[key] ?? (key === "final" ? "best2of3" : "single")
  );

  const startLabel =
    mode === "picking"
      ? t("sessions.finals.startPicking")
      : mode === "score_chase"
        ? t("sessions.finals.createRuns")
        : t("sessions.finals.createMatches");
  const countSummary = t(mode === "score_chase" ? "sessions.finals.runsSummary" : "sessions.finals.alliancesSummary", {
    count: alliances,
  });

  function onStart() {
    if (parsedCount === null || fieldSetId === null) return;
    const body: StartFinalsBody = {
      session_id: session.id,
      division_id: divisionId,
      team_count: parsedCount,
      alliance_selection: pairing,
      field_ids: [...tickedFieldIds].sort((a, b) => a - b),
    };
    if (divisionFieldSets.length > 1) body.field_set_id = fieldSetId;
    if (format === "single_elimination") body.wins_to_advance = winsToAdvance(roundChoices);
    start.mutate(body);
  }

  const exclusionError = exclude.error ?? undo.error;

  return (
    <div className="finals-setup">
      <div className="finals-setup__rankings">
        {exclusionError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(exclusionError, t("sessions.finals.genericError"))}
          </p>
        )}
        <FinalsRankingsTable
          rows={rows}
          cutAfterTeamId={cutAfterTeamId}
          busy={exclude.isPending || undo.isPending}
          onExclude={(teamId, reason) => {
            undo.reset();
            exclude.mutate({ teamId, reason });
          }}
          onUndo={(exclusionId) => {
            exclude.reset();
            undo.mutate(exclusionId);
          }}
        />
      </div>
      <FinalsSettingsPanel
        format={format}
        countText={shownCountText}
        onCountChange={setCountText}
        onAllTeams={() => setCountText(String(eligibleCount))}
        countSummary={countSummary}
        countError={countError}
        pairing={pairing}
        onPairingChange={setPairingChoice}
        fieldSets={divisionFieldSets}
        fieldSetId={fieldSetId}
        onFieldSetChange={(id) => {
          setChosenFieldSetId(id);
          setUntickedFieldIds(new Set());
        }}
        fields={setFields}
        tickedFieldIds={tickedFieldIds}
        onFieldToggle={(fieldId, ticked) =>
          setUntickedFieldIds((previous) => {
            const next = new Set(previous);
            if (ticked) next.delete(fieldId);
            else next.add(fieldId);
            return next;
          })
        }
        roundKeys={roundKeys}
        roundChoices={roundChoices}
        onRoundChoiceChange={(key, choice) => setRoundOverrides((previous) => ({ ...previous, [key]: choice }))}
        startLabel={startLabel}
        startDisabled={
          countError !== null || fieldSetId === null || tickedFieldIds.size === 0 || !matchFormat.data
        }
        starting={start.isPending}
        startError={start.error ? apiErrorMessage(start.error, t("sessions.finals.genericError")) : null}
        onStart={onStart}
      />
    </div>
  );
}
