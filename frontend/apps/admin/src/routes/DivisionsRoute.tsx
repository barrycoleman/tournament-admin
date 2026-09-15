import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import type { Division } from "../types";

interface DivisionTeamCounts {
  [divisionId: number]: number;
}

interface TeamSummary {
  id: number;
  division_id: number | null;
}

function useTeamCountsByDivision() {
  const { data } = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamSummary[]>("/api/teams"),
  });
  const counts: DivisionTeamCounts = {};
  let totalTeams = 0;
  for (const team of data ?? []) {
    totalTeams += 1;
    if (team.division_id !== null) {
      counts[team.division_id] = (counts[team.division_id] ?? 0) + 1;
    }
  }
  return { counts, totalTeams };
}

function RedistributeConfirmDialog({
  totalTeams,
  error,
  onConfirm,
  onCancel,
}: {
  totalTeams: number;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="alertdialog" aria-labelledby="redistribute-heading">
      <h2 id="redistribute-heading">{t("divisions.redistributeConfirmHeading")}</h2>
      <p>{t("divisions.redistributeConfirmBody", { count: totalTeams })}</p>
      {error && <p role="alert">{error}</p>}
      <button onClick={onConfirm}>{t("divisions.redistributeConfirmYes")}</button>
      <button onClick={onCancel}>{t("divisions.redistributeConfirmNo")}</button>
    </div>
  );
}

export function DivisionsRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [pendingRedistribute, setPendingRedistribute] = useState(false);
  const [redistributeError, setRedistributeError] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<Division | null>(null);

  const { data: divisions } = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });
  const { counts, totalTeams } = useTeamCountsByDivision();

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["divisions"] });
    queryClient.invalidateQueries({ queryKey: ["teams"] });
  };

  const createMutation = useMutation({
    mutationFn: () =>
      apiRequest<Division>("/api/divisions", {
        method: "POST",
        body: { name, target_team_count: target ? Number(target) : null },
      }),
    onSuccess: () => {
      setName("");
      setTarget("");
      invalidateAll();
      if (totalTeams > 0) {
        setRedistributeError(null);
        setPendingRedistribute(true);
      }
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, newName }: { id: number; newName: string }) =>
      apiRequest<Division>(`/api/divisions/${id}`, {
        method: "PATCH",
        body: { name: newName },
      }),
    onSuccess: invalidateAll,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest<void>(`/api/divisions/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setDeleteCandidate(null);
      invalidateAll();
      if (totalTeams > 0) {
        setRedistributeError(null);
        setPendingRedistribute(true);
      }
    },
  });

  const redistributeMutation = useMutation({
    mutationFn: () =>
      apiRequest<unknown>("/api/divisions/randomize", {
        method: "POST",
        body: { scope: "all" },
      }),
    onSuccess: () => {
      setPendingRedistribute(false);
      setRedistributeError(null);
      invalidateAll();
    },
    onError: (err) => {
      setRedistributeError(err instanceof ApiError ? err.detail : t("errors.generic"));
    },
  });

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate();
  }

  return (
    <div>
      <h1>{t("divisions.heading")}</h1>
      <ul>
        {divisions?.map((division) => {
          const count = counts[division.id] ?? 0;
          const label =
            division.target_team_count !== null
              ? t("divisions.teamCountWithTargetLabel", {
                  count,
                  target: division.target_team_count,
                })
              : t("divisions.teamCountLabel", { count });
          return (
            <li key={division.id}>
              <input
                aria-label={t("divisions.renameFieldLabel", { name: division.name })}
                defaultValue={division.name}
                onBlur={(event) => {
                  if (event.target.value !== division.name) {
                    renameMutation.mutate({ id: division.id, newName: event.target.value });
                  }
                }}
              />
              <span>{label}</span>
              <button onClick={() => setDeleteCandidate(division)}>
                {t("divisions.deleteAction")}
              </button>
            </li>
          );
        })}
      </ul>

      <form onSubmit={handleCreate}>
        <label htmlFor="new-division-name">{t("divisions.nameLabel")}</label>
        <input
          id="new-division-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <label htmlFor="new-division-target">{t("divisions.targetLabel")}</label>
        <input
          id="new-division-target"
          type="number"
          min="0"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        />
        <button type="submit" disabled={createMutation.isPending}>
          {t("divisions.addSubmit")}
        </button>
        {createMutation.isError && (
          <p role="alert">
            {createMutation.error instanceof ApiError
              ? createMutation.error.detail
              : t("errors.generic")}
          </p>
        )}
      </form>

      {deleteCandidate && (
        <div role="alertdialog" aria-labelledby="delete-division-heading">
          <h2 id="delete-division-heading">{t("divisions.deleteConfirmHeading")}</h2>
          <p>
            {t("divisions.deleteConfirmBody", {
              count: counts[deleteCandidate.id] ?? 0,
            })}
          </p>
          <button onClick={() => deleteMutation.mutate(deleteCandidate.id)}>
            {t("divisions.deleteAction")}
          </button>
          <button onClick={() => setDeleteCandidate(null)}>
            {t("divisions.redistributeConfirmNo")}
          </button>
        </div>
      )}

      {pendingRedistribute && (
        <RedistributeConfirmDialog
          totalTeams={totalTeams}
          error={redistributeError}
          onConfirm={() => redistributeMutation.mutate()}
          onCancel={() => {
            setPendingRedistribute(false);
            setRedistributeError(null);
          }}
        />
      )}
    </div>
  );
}
