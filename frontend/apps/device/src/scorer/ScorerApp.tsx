import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import type { DeviceSelf } from "../deviceApi";
import { TokenContext } from "../display/api";
import { EventBusContext, useLiveEvents, type EventBus } from "../display/events";
import { useLiveRefresh } from "../display/useLiveRefresh";
import { HomeScreen } from "../screens/HomeScreen";
import { PickingScreen } from "./PickingScreen";
import { useSelectingFinals } from "./useActiveFinals";

const RETRY_MS = 5_000;
const SAFETY_REFETCH_MS = 60_000;

/** A paired scorer or referee tablet. A screen switch picks what to show;
 * the scoring screens will join the picking screen here. */
export function ScorerApp({
  accessToken,
  device,
  bus,
  unreachable,
}: {
  accessToken: string;
  device: DeviceSelf;
  bus: EventBus;
  unreachable: boolean;
}) {
  const tokenRef = useRef(accessToken);
  tokenRef.current = accessToken;
  const getToken = useCallback(() => tokenRef.current, []);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: true,
            retryDelay: RETRY_MS,
            staleTime: Infinity,
            refetchInterval: SAFETY_REFETCH_MS,
            refetchOnWindowFocus: false,
          },
        },
      })
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TokenContext.Provider value={getToken}>
        <EventBusContext.Provider value={bus}>
          <ScorerScreens device={device} unreachable={unreachable} />
        </EventBusContext.Provider>
      </TokenContext.Provider>
    </QueryClientProvider>
  );
}

function ScorerScreens({ device, unreachable }: { device: DeviceSelf; unreachable: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  useLiveRefresh();
  // The event read carries the active session, which the display refresh map
  // leaves alone.
  useLiveEvents(["active_session_changed"], () => void queryClient.invalidateQueries({ queryKey: ["event"] }));
  const selecting = useSelectingFinals();
  return (
    <main className="device-screen scorer">
      {unreachable && (
        <p className="device-banner" role="status">
          {t("unreachable")}
        </p>
      )}
      {selecting ? <PickingScreen bracket={selecting} /> : <HomeScreen device={device} />}
    </main>
  );
}
