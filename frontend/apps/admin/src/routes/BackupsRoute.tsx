import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { apiErrorMessage } from "../apiErrorMessage";
import { formatSize, reasonKey } from "../backups/format";
import { useRestartPoll } from "../useRestartPoll";

export interface BackupEntry {
  filename: string;
  created_at: string;
  reason: string;
  size_bytes: number;
}

export interface BackupsState {
  folder: string;
  folder_is_default: boolean;
  last_backup_at: string | null;
  last_error: { message: string; at: string } | null;
  backups: BackupEntry[];
}

const BACKUPS_KEY = ["backups"];

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export function BackupsRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const backups = useQuery({
    queryKey: BACKUPS_KEY,
    queryFn: () => apiRequest<BackupsState>("/api/backups"),
    refetchOnWindowFocus: true,
  });
  const [editingFolder, setEditingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState("");
  const [restoring, setRestoring] = useState<BackupEntry | null>(null);
  const restart = useRestartPoll(undefined, "restarted");

  const backUpNow = useMutation({
    mutationFn: () => apiRequest<BackupEntry>("/api/backups", { method: "POST" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: BACKUPS_KEY }),
  });
  const saveFolder = useMutation({
    mutationFn: (folder: string | null) =>
      apiRequest<BackupsState>("/api/backups/folder", { method: "PUT", body: { folder } }),
    onSuccess: (data) => {
      queryClient.setQueryData(BACKUPS_KEY, data);
      setEditingFolder(false);
    },
  });
  const restore = useMutation({
    mutationFn: async (entry: BackupEntry) => {
      const { boot_id } = await apiRequest<{ boot_id: string }>("/api/time-sync");
      await apiRequest(`/api/backups/${encodeURIComponent(entry.filename)}/restore`, { method: "POST" });
      return boot_id;
    },
    onSuccess: (bootId) => {
      setRestoring(null);
      restart.start(bootId);
    },
  });

  if (!backups.data) return null;
  const state = backups.data;

  return (
    <div>
      <h1>{t("backups.heading")}</h1>
      <p className="field__hint">{t("backups.intro")}</p>

      {restart.status === "waiting" && (
        <p className="alert" role="status">
          {t("backups.restoring")}
        </p>
      )}
      {restart.status === "timedOut" && (
        <p className="alert alert-warning" role="status">
          {t("backups.restoreTimedOut")}
        </p>
      )}

      <div className="field">
        <span className="field__label" id="backup-folder-label">
          {t("backups.folderLabel")}
        </span>
        {editingFolder ? (
          <>
            <input
              className="input"
              aria-labelledby="backup-folder-label"
              value={folderDraft}
              onChange={(event) => setFolderDraft(event.target.value)}
            />
            <div className="dialog__actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={saveFolder.isPending}
                onClick={() => saveFolder.mutate(folderDraft)}
              >
                {t("backups.save")}
              </button>
              <button type="button" className="btn" onClick={() => setEditingFolder(false)}>
                {t("backups.cancel")}
              </button>
            </div>
          </>
        ) : (
          <p>
            <code>{state.folder}</code>{" "}
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                setFolderDraft(state.folder);
                setEditingFolder(true);
              }}
            >
              {t("backups.change")}
            </button>{" "}
            {!state.folder_is_default && (
              <button type="button" className="btn btn-small" onClick={() => saveFolder.mutate(null)}>
                {t("backups.useDefault")}
              </button>
            )}
          </p>
        )}
        {saveFolder.isError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(saveFolder.error, t("errors.generic"))}
          </p>
        )}
      </div>

      {state.last_error && (
        <p className="alert alert-danger" role="alert">
          {t("backups.lastError", { time: formatTime(state.last_error.at), message: state.last_error.message })}
        </p>
      )}
      <p>
        {state.last_backup_at ? t("backups.lastBackup", { time: formatTime(state.last_backup_at) }) : null}{" "}
        <button
          type="button"
          className="btn btn-primary"
          disabled={backUpNow.isPending}
          onClick={() => backUpNow.mutate()}
        >
          {t("backups.backUpNow")}
        </button>
      </p>
      {backUpNow.isError && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(backUpNow.error, t("errors.generic"))}
        </p>
      )}

      {state.backups.length === 0 ? (
        <p>{t("backups.noneYet")}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("backups.time")}</th>
                <th>{t("backups.reason")}</th>
                <th>{t("backups.size")}</th>
                <th className="table__actions" />
              </tr>
            </thead>
            <tbody>
              {state.backups.map((entry) => (
                <tr key={entry.filename}>
                  <td className="table__nowrap">{formatTime(entry.created_at)}</td>
                  <td>{t(reasonKey(entry.reason), { defaultValue: entry.reason })}</td>
                  <td className="table__nowrap">{formatSize(entry.size_bytes)}</td>
                  <td className="table__actions">
                    <button type="button" className="btn btn-small" onClick={() => setRestoring(entry)}>
                      {t("backups.restore")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {restoring && (
        <ConfirmDialog
          heading={t("backups.restoreHeading")}
          body={t("backups.restoreBody", { time: formatTime(restoring.created_at) })}
          confirmLabel={t("backups.restore")}
          cancelLabel={t("backups.cancel")}
          isPending={restore.isPending}
          error={restore.isError ? apiErrorMessage(restore.error, t("errors.generic")) : null}
          onConfirm={() => restore.mutate(restoring)}
          onCancel={() => {
            restore.reset();
            setRestoring(null);
          }}
        />
      )}
    </div>
  );
}
