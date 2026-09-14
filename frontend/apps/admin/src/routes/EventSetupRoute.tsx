import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import type { EventRead, PluginSummary, ServerInfo } from "../types";

function PluginList({
  kind,
  headingKey,
  installLabelKey,
  installSubmitKey,
}: {
  kind: "games" | "schedulers";
  headingKey: string;
  installLabelKey: string;
  installSubmitKey: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = ["plugins", kind];

  const { data: plugins } = useQuery({
    queryKey,
    queryFn: () => apiRequest<PluginSummary[]>(`/api/plugins/${kind}`),
  });

  const { data: event } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });

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
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const selectMutation = useMutation({
    mutationFn: (name: string) =>
      apiRequest<EventRead>("/api/event/game-plugin", {
        method: "POST",
        body: { name },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["event"] }),
  });

  function handleFileChange(changeEvent: ChangeEvent<HTMLInputElement>) {
    const file = changeEvent.target.files?.[0];
    if (file) installMutation.mutate(file);
  }

  return (
    <section>
      <h2>{t(headingKey)}</h2>
      <ul>
        {plugins?.map((plugin) => (
          <li key={plugin.name}>
            {plugin.display_name} ({plugin.version})
            {kind === "games" &&
              (event?.game_plugin_name === plugin.name ? (
                <span> — {t("eventSetup.selectedLabel")}</span>
              ) : (
                <button
                  onClick={() => selectMutation.mutate(plugin.name)}
                  disabled={Boolean(event?.game_plugin_name) || selectMutation.isPending}
                >
                  {t("eventSetup.selectSubmit")}
                </button>
              ))}
          </li>
        ))}
      </ul>
      <label htmlFor={`install-${kind}`}>{t(installLabelKey)}</label>
      <input
        id={`install-${kind}`}
        type="file"
        accept=".zip"
        onChange={handleFileChange}
      />
      {installMutation.isError && (
        <p role="alert">
          {installMutation.error instanceof ApiError
            ? installMutation.error.detail
            : "Install failed."}
        </p>
      )}
      <span aria-hidden="true">{t(installSubmitKey)}</span>
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
    <section>
      <h2>{t("eventSetup.serverInfoHeading")}</h2>
      {data.addresses.map((address) => (
        <div key={address}>
          <p>
            {t("eventSetup.serverInfoAddressLabel")}: {address}:{data.port}
          </p>
          <canvas ref={(node) => (canvasRefs.current[address] = node)} />
        </div>
      ))}
    </section>
  );
}

export function EventSetupRoute() {
  const { t } = useTranslation();
  return (
    <div>
      <h1>{t("eventSetup.heading")}</h1>
      <PluginList
        kind="games"
        headingKey="eventSetup.gamePluginsHeading"
        installLabelKey="eventSetup.installLabel"
        installSubmitKey="eventSetup.installGameSubmit"
      />
      <PluginList
        kind="schedulers"
        headingKey="eventSetup.schedulerPluginsHeading"
        installLabelKey="eventSetup.installLabel"
        installSubmitKey="eventSetup.installSchedulerSubmit"
      />
      <ServerInfoPanel />
    </div>
  );
}
