import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import { useRestartPoll } from "../useRestartPoll";

interface DirectoryListResponse {
  allowed_directories: string[];
}

interface TournamentFileEntry {
  filename: string;
  path: string;
  size_bytes: number;
  modified_at: string;
}

interface TournamentListResponse {
  tournaments: TournamentFileEntry[];
}

type PickerScreen = "menu" | "create" | "open";

/**
 * Filenames land directly on the server's filesystem, so keep the field
 * that types them constrained as the organizer edits it rather than
 * rejecting after the fact: whitespace becomes an underscore (rather than
 * getting silently dropped, which would jam adjacent words together) and
 * anything else that isn't a letter, digit, underscore, hyphen, or a
 * literal period (kept so the ".db" suffix stays editable/visible while
 * typing) is dropped. This mirrors the backend's own filename validation
 * in `routers/picker.py`, which stays the authoritative guard for any
 * other API caller.
 */
export function sanitizeFilename(raw: string): string {
  return raw.replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.-]/g, "");
}

/** Appends the required .db extension if the organizer's edit dropped it. */
export function withDbExtension(name: string): string {
  return name.endsWith(".db") ? name : `${name}.db`;
}

/**
 * A fresh, ready-to-use default so creating a tournament needs no typing at
 * all -- the organizer can accept it as-is or replace it. Timestamped in
 * local wall-clock time (not UTC): the label is for a human glancing at a
 * directory listing, not a machine.
 */
export function generateDefaultFilename(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(
    now.getHours()
  )}${pad(now.getMinutes())}`;
  return `${stamp}-tournament.db`;
}

export function PickerRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [screen, setScreen] = useState<PickerScreen>("menu");
  const [directory, setDirectory] = useState("");
  const [filename, setFilename] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  const [newDirectoryPath, setNewDirectoryPath] = useState("");
  const [addingDirectory, setAddingDirectory] = useState(false);
  const { status: restartStatus, start: startRestartPoll } = useRestartPoll();

  const { data: directoriesData } = useQuery({
    queryKey: ["picker", "directories"],
    queryFn: () => apiRequest<DirectoryListResponse>("/api/picker/directories"),
  });
  const directories = directoriesData?.allowed_directories ?? [];

  const { data: tournamentsData } = useQuery({
    queryKey: ["picker", "tournaments", directory],
    queryFn: () =>
      apiRequest<TournamentListResponse>(
        `/api/picker/tournaments?dir=${encodeURIComponent(directory)}`
      ),
    enabled: screen === "open" && directory !== "",
  });
  const tournaments = tournamentsData?.tournaments ?? [];

  const addDirectoryMutation = useMutation({
    mutationFn: (path: string) =>
      apiRequest<DirectoryListResponse>("/api/picker/directories", {
        method: "POST",
        body: { path },
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(["picker", "directories"], result);
      setNewDirectoryPath("");
      setAddingDirectory(false);
    },
  });

  const createMutation = useMutation({
    mutationFn: (finalFilename: string) =>
      apiRequest<unknown>("/api/picker/create", {
        method: "POST",
        body: { directory, filename: finalFilename },
      }),
    onSuccess: () => startRestartPoll(),
  });

  const openMutation = useMutation({
    mutationFn: () =>
      apiRequest<unknown>("/api/picker/open", {
        method: "POST",
        body: { path: selectedFile },
      }),
    onSuccess: () => startRestartPoll(),
  });

  if (restartStatus === "waiting") {
    return (
      <div className="picker-restarting">
        <p role="status">{t("picker.restartingMessage")}</p>
      </div>
    );
  }

  const timedOutAlert = restartStatus === "timedOut" && (
    <p className="alert alert-danger" role="alert">
      {t("picker.restartTimedOutMessage")}
    </p>
  );

  function renderDirectoryPicker(selected: string, onSelect: (dir: string) => void) {
    return (
      <div className="field">
        <label className="field__label" htmlFor="picker-directory">
          {t("picker.directoryLabel")}
        </label>
        <select
          className="select"
          id="picker-directory"
          value={selected}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">{t("picker.directoryPlaceholder")}</option>
          {directories.map((dir) => (
            <option key={dir} value={dir}>
              {dir}
            </option>
          ))}
        </select>
        {!addingDirectory && (
          <button className="btn-link" type="button" onClick={() => setAddingDirectory(true)}>
            {t("picker.addDirectoryAction")}
          </button>
        )}
        {addingDirectory && (
          <div className="field" style={{ marginTop: "var(--space-2)" }}>
            <label className="field__label" htmlFor="picker-new-directory">
              {t("picker.newDirectoryLabel")}
            </label>
            <div className="form-actions" style={{ marginTop: 0 }}>
              <input
                className="input"
                id="picker-new-directory"
                value={newDirectoryPath}
                onChange={(event) => setNewDirectoryPath(event.target.value)}
                style={{ flex: 1 }}
              />
              <button
                className="btn btn-primary btn-small"
                type="button"
                onClick={() => addDirectoryMutation.mutate(newDirectoryPath)}
                disabled={addDirectoryMutation.isPending}
              >
                {t("picker.addDirectoryConfirm")}
              </button>
            </div>
            {addDirectoryMutation.isError && (
              <p className="alert alert-danger" role="alert">
                {addDirectoryMutation.error instanceof ApiError
                  ? addDirectoryMutation.error.detail
                  : t("errors.generic")}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  if (screen === "menu") {
    return (
      <main className="auth-screen">
        <div className="auth-card">
          <h1>{t("picker.heading")}</h1>
          {timedOutAlert}
          <div className="picker-menu">
            <button
              className="btn btn-primary"
              onClick={() => {
                setFilename(generateDefaultFilename());
                setScreen("create");
              }}
            >
              {t("picker.createAction")}
            </button>
            <button className="btn" onClick={() => setScreen("open")}>
              {t("picker.openAction")}
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (screen === "create") {
    return (
      <main className="auth-screen">
        <div className="auth-card auth-card--wide">
          <h1>{t("picker.createAction")}</h1>
          {timedOutAlert}
          {renderDirectoryPicker(directory, setDirectory)}
          <div className="field">
            <label className="field__label" htmlFor="picker-filename">
              {t("picker.filenameLabel")}
            </label>
            <input
              className="input"
              id="picker-filename"
              value={filename}
              onChange={(event) => setFilename(sanitizeFilename(event.target.value))}
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
            <button
              className="btn btn-primary"
              onClick={() => {
                const finalFilename = withDbExtension(filename);
                setFilename(finalFilename);
                createMutation.mutate(finalFilename);
              }}
              disabled={createMutation.isPending || !directory || !filename}
            >
              {t("picker.createSubmit")}
            </button>
            <button className="btn" onClick={() => setScreen("menu")}>
              {t("picker.backAction")}
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-screen">
      <div className="auth-card auth-card--wide">
        <h1>{t("picker.openAction")}</h1>
        {timedOutAlert}
        {renderDirectoryPicker(directory, (dir) => {
          setDirectory(dir);
          setSelectedFile("");
        })}
        <div className="field">
          <label className="field__label" htmlFor="picker-tournament-file">
            {t("picker.tournamentFileLabel")}
          </label>
          <select
            className="select"
            id="picker-tournament-file"
            value={selectedFile}
            onChange={(event) => setSelectedFile(event.target.value)}
          >
            <option value="">{t("picker.directoryPlaceholder")}</option>
            {tournaments.map((file) => (
              <option key={file.path} value={file.path}>
                {file.filename}
              </option>
            ))}
          </select>
        </div>
        {openMutation.isError && (
          <p className="alert alert-danger" role="alert">
            {openMutation.error instanceof ApiError
              ? openMutation.error.detail
              : t("errors.generic")}
          </p>
        )}
        <div className="form-actions">
          <button
            className="btn btn-primary"
            onClick={() => openMutation.mutate()}
            disabled={openMutation.isPending || !selectedFile}
          >
            {t("picker.openSubmit")}
          </button>
          <button className="btn" onClick={() => setScreen("menu")}>
            {t("picker.backAction")}
          </button>
        </div>
      </div>
    </main>
  );
}
