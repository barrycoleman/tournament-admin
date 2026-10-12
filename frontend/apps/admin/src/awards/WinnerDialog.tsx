import { useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { Modal } from "../components/Modal";
import { apiErrorMessage } from "../apiErrorMessage";
import { matchTeams } from "../skills/recordForm";
import type { AwardRead, AwardSlotRead, TeamSummary } from "../types";
import { judgedWarning, otherAwards } from "./teamHistory";
import { awardsKey, slotKey, teamHistoryKey, useTeamHistory } from "./useAwards";

interface Participant {
  team_id: number;
  checked_in: boolean;
}

/** Choose a judged winner (one team) or override a performance slot (teams and a reason). */
export function WinnerDialog({
  sessionId,
  award,
  slot,
  mode,
  onClose,
}: {
  sessionId: number;
  award: AwardRead;
  slot: AwardSlotRead;
  mode: "judged" | "override";
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const searchId = useId();
  const queryClient = useQueryClient();
  const teams = useQuery({ queryKey: ["teams"], queryFn: () => apiRequest<TeamSummary[]>("/api/teams") });
  const participants = useQuery({
    queryKey: ["participants", sessionId],
    queryFn: () => apiRequest<Participant[]>(`/api/sessions/${sessionId}/participants`),
  });
  const history = useTeamHistory(sessionId);
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<number[]>(slot.winners.map((w) => w.team_id));
  const [reason, setReason] = useState(slot.override_reason ?? "");
  const [problem, setProblem] = useState<string | null>(null);

  const eligible = useMemo(() => {
    const entered = new Set((participants.data ?? []).map((p) => p.team_id));
    return (teams.data ?? []).filter(
      (team) => entered.has(team.id) && (slot.division_id === null || team.division_id === slot.division_id)
    );
  }, [teams.data, participants.data, slot.division_id]);
  const shown = matchTeams(eligible, search);
  // The slot's current winners can include a team the list doesn't offer (a
  // season-basis winner not entered this session); only listed teams count.
  const picked = useMemo(() => {
    const listed = new Set(eligible.map((team) => team.id));
    return chosen.filter((id) => listed.has(id));
  }, [chosen, eligible]);

  const save = useMutation({
    mutationFn: () =>
      apiRequest(`/api/awards/${award.id}/slots/${slotKey(slot)}`, {
        method: "PUT",
        body: mode === "judged" ? { team_id: picked[0] } : { team_ids: picked, reason: reason.trim() },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: awardsKey(sessionId) });
      queryClient.invalidateQueries({ queryKey: teamHistoryKey(sessionId) });
      onClose();
    },
  });

  function submit() {
    if (picked.length === 0) {
      setProblem(t(mode === "judged" ? "awards.winner.pickTeam" : "awards.winner.pickTeams"));
      return;
    }
    if (mode === "override" && reason.trim() === "") {
      setProblem(t("awards.winner.reasonRequired"));
      return;
    }
    setProblem(null);
    if (!save.isPending) save.mutate();
  }

  const heading = t(mode === "judged" ? "awards.winner.chooseHeading" : "awards.winner.overrideHeading", {
    name: award.name,
  });
  return (
    <Modal labelledBy={headingId} onCancel={() => !save.isPending && onClose()}>
      <h2 id={headingId}>{heading}</h2>
      <div className="field">
        <label className="field__label" htmlFor={searchId}>
          {t("awards.winner.searchLabel")}
        </label>
        <input id={searchId} className="input" value={search} data-autofocus onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div role={mode === "judged" ? "radiogroup" : "group"} aria-label={t("awards.winner.teamsLabel")} className="list-plain">
        {shown.map((team) => {
          const warning = history.data ? judgedWarning(history.data, team.id, award.id, sessionId) : null;
          const others = history.data ? otherAwards(history.data, team.id, award.id) : [];
          return (
            <label key={team.id} className="list-row">
              <input
                type={mode === "judged" ? "radio" : "checkbox"}
                name="award-team"
                checked={chosen.includes(team.id)}
                onChange={(e) =>
                  setChosen(
                    mode === "judged"
                      ? [team.id]
                      : e.target.checked
                        ? [...picked, team.id]
                        : picked.filter((id) => id !== team.id)
                  )
                }
              />{" "}
              <span className="list-row__main">
                {team.number} {team.name}
              </span>
              {warning && (
                <span className="badge badge-warning">
                  {t(warning === "session" ? "awards.winner.warnSession" : "awards.winner.warnSeason")}
                </span>
              )}
              {others.length > 0 && (
                <span className="list-row__meta">
                  {t("awards.winner.otherAwards", {
                    list: others.map((a) => `${a.award_name} (${a.session_label})`).join(", "),
                  })}
                </span>
              )}
            </label>
          );
        })}
      </div>
      {shown.length === 0 && <p className="field__hint">{t("awards.winner.noTeams")}</p>}
      {mode === "override" && (
        <label className="field">
          <span className="field__label">{t("awards.winner.reasonLabel")}</span>
          <textarea className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      )}
      {(problem || save.isError) && (
        <p className="alert alert-danger" role="alert">
          {problem ?? apiErrorMessage(save.error, t("errors.generic"))}
        </p>
      )}
      <div className="dialog__actions">
        <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={submit}>
          {t("awards.winner.save")}
        </button>
        <button type="button" className="btn" onClick={onClose} disabled={save.isPending}>
          {t("awards.cancel")}
        </button>
      </div>
    </Modal>
  );
}
