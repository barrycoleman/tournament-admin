import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { GamePluginChangeDialog } from "../gamePlugin/GamePluginChangeDialog";
import { useGamePlugin } from "../gamePlugin/useGamePlugin";
import { RankingSettingsPanel } from "../rankings/RankingSettingsPanel";
import { RANKING_SETTINGS_KEY } from "../rankings/useRankingSettings";
import { SkillsSettingsPanel } from "../skills/SkillsSettingsPanel";
import { SKILLS_SETTINGS_KEY } from "../skills/useSkillsSettings";
import type { EventRead, GamePluginChangePreview, PluginSummary, ServerInfo } from "../types";

function InstallPluginField({
  kind,
  labelKey,
  submitKey,
}: {
  kind: "games" | "schedulers";
  labelKey: string;
  submitKey: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const installMutation = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return apiRequest<PluginSummary>(`/api/plugins/${kind}`, {
        method: "POST",
        body: form,
        isFormData: true,
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["plugins", kind] }),
  });

  function handleFileChange(changeEvent: ChangeEvent<HTMLInputElement>) {
    const file = changeEvent.target.files?.[0];
    if (file) installMutation.mutate(file);
  }

  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor={`install-${kind}`}>
          {t(labelKey)}
        </label>
        <input
          className="input"
          id={`install-${kind}`}
          type="file"
          accept=".zip"
          onChange={handleFileChange}
        />
      </div>
      {installMutation.isError && (
        <p className="alert alert-danger" role="alert">
          {installMutation.error instanceof ApiError
            ? installMutation.error.detail
            : t("errors.pluginInstallFailed")}
        </p>
      )}
      <span aria-hidden="true">{t(submitKey)}</span>
    </>
  );
}

function PluginList({
  headingKey,
  installLabelKey,
  installSubmitKey,
}: {
  headingKey: string;
  installLabelKey: string;
  installSubmitKey: string;
}) {
  const { t } = useTranslation();
  const { data: plugins } = useQuery({
    queryKey: ["plugins", "schedulers"],
    queryFn: () => apiRequest<PluginSummary[]>("/api/plugins/schedulers"),
  });

  return (
    <section className="panel">
      <h2>{t(headingKey)}</h2>
      <ul className="list-plain">
        {plugins?.map((plugin) => (
          <li className="list-row" key={plugin.name}>
            <span className="list-row__main">
              {plugin.display_name} ({plugin.version})
            </span>
          </li>
        ))}
      </ul>
      <InstallPluginField kind="schedulers" labelKey={installLabelKey} submitKey={installSubmitKey} />
    </section>
  );
}

interface PendingChange {
  /** null means clear the selection. */
  target: { name: string; displayName: string } | null;
  preview: GamePluginChangePreview;
}

function GamePluginSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { selected, locked, name: selectedName } = useGamePlugin();
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [sectionError, setSectionError] = useState<string | null>(null);

  const { data: plugins } = useQuery({
    queryKey: ["plugins", "games"],
    queryFn: () => apiRequest<PluginSummary[]>("/api/plugins/games"),
  });

  function refreshAfterChange() {
    for (const queryKey of [
      ["event"],
      RANKING_SETTINGS_KEY,
      SKILLS_SETTINGS_KEY,
      ["matchFormat"],
      ["awards"],
    ]) {
      queryClient.invalidateQueries({ queryKey });
    }
  }

  // The lock starts when matches are scheduled or a skills attempt is recorded, and neither broadcasts a plugin change,
  // so a refusal means this tab is stale: refetch the event so it shows the locked note instead of the buttons.
  function noteRefusal(error: unknown) {
    setSectionError(apiErrorMessage(error, t("errors.generic")));
    if (error instanceof ApiError && error.status === 409) {
      queryClient.invalidateQueries({ queryKey: ["event"] });
    }
  }

  const selectMutation = useMutation({
    mutationFn: (name: string) =>
      apiRequest<EventRead>("/api/event/game-plugin", { method: "POST", body: { name } }),
    onMutate: () => setSectionError(null),
    onSuccess: () => refreshAfterChange(),
    onError: noteRefusal,
  });

  const dryRunMutation = useMutation({
    mutationFn: (target: PendingChange["target"]) =>
      target
        ? apiRequest<GamePluginChangePreview>("/api/event/game-plugin?dry_run=true", {
            method: "POST",
            body: { name: target.name },
          })
        : apiRequest<GamePluginChangePreview>("/api/event/game-plugin?dry_run=true", {
            method: "DELETE",
          }),
    onMutate: () => setSectionError(null),
    onSuccess: (preview, target) => setPending({ target, preview }),
    onError: noteRefusal,
  });

  const changeMutation = useMutation({
    mutationFn: (target: PendingChange["target"]) =>
      target
        ? apiRequest<EventRead>("/api/event/game-plugin", {
            method: "POST",
            body: { name: target.name },
          })
        : apiRequest<EventRead>("/api/event/game-plugin", { method: "DELETE" }),
    onSuccess: () => {
      setPending(null);
      refreshAfterChange();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        queryClient.invalidateQueries({ queryKey: ["event"] });
      }
    },
  });

  return (
    <section className="panel" id="game-plugins">
      <h2>{t("eventSetup.gamePluginsHeading")}</h2>
      {!selected && <p className="field__hint">{t("eventSetup.chooseFirstHint")}</p>}
      <ul className="list-plain">
        {plugins?.map((plugin) => (
          <li className="list-row" key={plugin.name}>
            <span className="list-row__main">
              {plugin.display_name} ({plugin.version})
            </span>
            {selectedName === plugin.name ? (
              <span className="badge badge-neutral">{t("eventSetup.selectedLabel")}</span>
            ) : !selected ? (
              <button
                className="btn btn-small"
                onClick={() => selectMutation.mutate(plugin.name)}
                disabled={selectMutation.isPending}
              >
                {t("eventSetup.selectSubmit")}
              </button>
            ) : !locked ? (
              <button
                className="btn btn-small"
                onClick={() =>
                  dryRunMutation.mutate({ name: plugin.name, displayName: plugin.display_name })
                }
                disabled={dryRunMutation.isPending}
              >
                {t("eventSetup.switchSubmit")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {selected && !locked && (
        <button
          className="btn btn-small"
          onClick={() => dryRunMutation.mutate(null)}
          disabled={dryRunMutation.isPending}
        >
          {t("eventSetup.clearSubmit")}
        </button>
      )}
      {selected && locked && <p className="field__hint">{t("eventSetup.lockedNote")}</p>}
      {sectionError && (
        <p className="alert alert-danger" role="alert">
          {sectionError}
        </p>
      )}
      <InstallPluginField
        kind="games"
        labelKey="eventSetup.installLabel"
        submitKey="eventSetup.installGameSubmit"
      />
      {pending && (
        <GamePluginChangeDialog
          target={pending.target}
          preview={pending.preview}
          isPending={changeMutation.isPending}
          error={changeMutation.isError ? apiErrorMessage(changeMutation.error, t("errors.generic")) : null}
          onConfirm={() => changeMutation.mutate(pending.target)}
          onCancel={() => {
            changeMutation.reset();
            setPending(null);
          }}
        />
      )}
    </section>
  );
}

function ServerInfoPanel() {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ["server-info"],
    queryFn: () => apiRequest<ServerInfo>("/api/server-info"),
  });
  const canvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({});

  useEffect(() => {
    if (!data) return;
    for (const address of data.addresses) {
      const canvas = canvasRefs.current[address];
      if (canvas) {
        void QRCode.toCanvas(canvas, `http://${address}:${data.port}`);
      }
    }
  }, [data]);

  if (!data) return null;

  return (
    <section className="panel">
      <h2>{t("eventSetup.serverInfoHeading")}</h2>
      <div className="server-info-grid">
        {data.addresses.map((address) => (
          <div className="server-info-card" key={address}>
            <canvas ref={(node) => { canvasRefs.current[address] = node; }} />
            <p>
              {t("eventSetup.serverInfoAddressLabel")}: {address}:{data.port}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function EventSetupRoute() {
  const { t } = useTranslation();
  return (
    <div>
      <h1>{t("eventSetup.heading")}</h1>
      <GamePluginSection />
      <PluginList
        headingKey="eventSetup.schedulerPluginsHeading"
        installLabelKey="eventSetup.installLabel"
        installSubmitKey="eventSetup.installSchedulerSubmit"
      />
      <RankingSettingsPanel />
      <SkillsSettingsPanel />
      <ServerInfoPanel />
    </div>
  );
}
