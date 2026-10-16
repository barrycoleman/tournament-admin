import { useCallback, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DeviceSelf } from "../deviceApi";
import { TokenContext } from "./api";
import { DisplayRoot } from "./DisplayRoot";
import { EventBusContext, type EventBus } from "./events";

export const RETRY_MS = 5_000;
export const SAFETY_REFETCH_MS = 60_000;

/** A paired Display: kiosk screens fed by REST reads and live events. */
export function DisplayApp({
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
            // A TV has no keyboard: keep retrying, and refetch now and then in
            // case a live event was missed.
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
          <DisplayRoot deviceName={device.name} unreachable={unreachable} />
        </EventBusContext.Provider>
      </TokenContext.Provider>
    </QueryClientProvider>
  );
}
