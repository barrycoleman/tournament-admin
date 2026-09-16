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
    <div className="dialog-overlay">
      <div className="dialog" role="alertdialog" aria-labelledby="redistribute-heading">
        <h2 id="redistribute-heading">{t("divisions.redistributeConfirmHeading")}</h2>
        <p>{t("divisions.redistributeConfirmBody", { count: totalTeams })}</p>
        {error && (
          <p className="alert alert-danger" role="alert">
            {error}
          </p>
        )}
        <div className="dialog__actions">
          <button className="btn btn-primary" onClick={onConfirm}>
            {t("divisions.redistributeConfirmYes")}
          </button>
          <button className="btn" onClick={onCancel}>
            {t("divisions.redistributeConfirmNo")}
          </button>
        </div>
      </div>
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
  const [renameError, setRenameError] = useState<string | null>(null);
  const [addingDivision, setAddingDivision] = useState(false);

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
      setAddingDivision(false);
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
    onSuccess: () => {
      setRenameError(null);
      invalidateAll();
    },
    onError: (err) => {
      setRenameError(err instanceof ApiError ? err.detail : t("errors.generic"));
    },
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
      <ul className="list-plain">
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
            <li className="list-row" key={division.id}>
              <input
                className="input"
                style={{ flex: 1 }}
                aria-label={t("divisions.renameFieldLabel", { name: division.name })}
                defaultValue={division.name}
                onBlur={(event) => {
                  if (event.target.value !== division.name) {
                    renameMutation.mutate({ id: division.id, newName: event.target.value });
                  }
                }}
              />
              <span className="list-row__meta">{label}</span>
              {(divisions?.length ?? 0) > 1 && (
                <button
                  className="btn btn-danger btn-small"
                  onClick={() => setDeleteCandidate(division)}
                >
                  {t("divisions.deleteAction")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {renameError && (
        <p className="alert alert-danger" role="alert">
          {renameError}
        </p>
      )}

      {!addingDivision && (
        <button className="btn" type="button" onClick={() => setAddingDivision(true)}>
          {t("divisions.addDivisionAction")}
        </button>
      )}

      {addingDivision && (
        <form className="panel" onSubmit={handleCreate}>
          <div className="field">
            <label className="field__label" htmlFor="new-division-name">
              {t("divisions.nameLabel")}
            </label>
            <input
              className="input"
              id="new-division-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="new-division-target">
              {t("divisions.targetLabel")}
            </label>
            <input
              className="input"
              id="new-division-target"
              type="number"
              min="0"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            />
          </div>
          {createMutation.isError && (
            <p className="alert alert-danger" role="alert">
              {createMutation.error instanceof ApiError
                ? createMutation.error.detail
                : t("errors.generic")}
            </p>
          )}
          <div className="form-actions">
            <button className="btn btn-primary" type="submit" disabled={createMutation.isPending}>
              {t("divisions.addSubmit")}
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setAddingDivision(false);
                setName("");
                setTarget("");
                createMutation.reset();
              }}
            >
              {t("divisions.cancelAction")}
            </button>
          </div>
        </form>
      )}

      {deleteCandidate && (
        <div className="dialog-overlay">
          <div className="dialog" role="alertdialog" aria-labelledby="delete-division-heading">
            <h2 id="delete-division-heading">{t("divisions.deleteConfirmHeading")}</h2>
            <p>
              {t("divisions.deleteConfirmBody", {
                count: counts[deleteCandidate.id] ?? 0,
              })}
            </p>
            <div className="dialog__actions">
              <button
                className="btn btn-danger"
                onClick={() => deleteMutation.mutate(deleteCandidate.id)}
              >
                {t("divisions.deleteAction")}
              </button>
              <button className="btn" onClick={() => setDeleteCandidate(null)}>
                {t("divisions.cancelAction")}
              </button>
            </div>
          </div>
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
