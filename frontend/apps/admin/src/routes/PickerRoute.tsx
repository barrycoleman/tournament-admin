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
    mutationFn: () =>
      apiRequest<unknown>("/api/picker/create", {
        method: "POST",
        body: { directory, filename },
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
      <main>
        <p role="status">{t("picker.restartingMessage")}</p>
      </main>
    );
  }

  function renderDirectoryPicker(selected: string, onSelect: (dir: string) => void) {
    return (
      <div>
        <label htmlFor="picker-directory">{t("picker.directoryLabel")}</label>
        <select
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
          <button type="button" onClick={() => setAddingDirectory(true)}>
            {t("picker.addDirectoryAction")}
          </button>
        )}
        {addingDirectory && (
          <div>
            <label htmlFor="picker-new-directory">{t("picker.newDirectoryLabel")}</label>
            <input
              id="picker-new-directory"
              value={newDirectoryPath}
              onChange={(event) => setNewDirectoryPath(event.target.value)}
            />
            <button
              type="button"
              onClick={() => addDirectoryMutation.mutate(newDirectoryPath)}
              disabled={addDirectoryMutation.isPending}
            >
              {t("picker.addDirectoryConfirm")}
            </button>
            {addDirectoryMutation.isError && (
              <p role="alert">
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
      <main>
        <h1>{t("picker.heading")}</h1>
        {restartStatus === "timedOut" && (
          <p role="alert">{t("picker.restartTimedOutMessage")}</p>
        )}
        <button onClick={() => setScreen("create")}>{t("picker.createAction")}</button>
        <button onClick={() => setScreen("open")}>{t("picker.openAction")}</button>
      </main>
    );
  }

  if (screen === "create") {
    return (
      <main>
        <h1>{t("picker.createAction")}</h1>
        {renderDirectoryPicker(directory, setDirectory)}
        <label htmlFor="picker-filename">{t("picker.filenameLabel")}</label>
        <input
          id="picker-filename"
          value={filename}
          onChange={(event) => setFilename(event.target.value)}
        />
        <button
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending || !directory || !filename}
        >
          {t("picker.createSubmit")}
        </button>
        {createMutation.isError && (
          <p role="alert">
            {createMutation.error instanceof ApiError
              ? createMutation.error.detail
              : t("errors.generic")}
          </p>
        )}
        <button onClick={() => setScreen("menu")}>{t("picker.backAction")}</button>
      </main>
    );
  }

  return (
    <main>
      <h1>{t("picker.openAction")}</h1>
      {renderDirectoryPicker(directory, (dir) => {
        setDirectory(dir);
        setSelectedFile("");
      })}
      <label htmlFor="picker-tournament-file">{t("picker.tournamentFileLabel")}</label>
      <select
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
      <button
        onClick={() => openMutation.mutate()}
        disabled={openMutation.isPending || !selectedFile}
      >
        {t("picker.openSubmit")}
      </button>
      {openMutation.isError && (
        <p role="alert">
          {openMutation.error instanceof ApiError
            ? openMutation.error.detail
            : t("errors.generic")}
        </p>
      )}
      <button onClick={() => setScreen("menu")}>{t("picker.backAction")}</button>
    </main>
  );
}
