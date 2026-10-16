import { createContext, useContext, useEffect, useRef } from "react";

export interface LiveEvent {
  event: string;
  data: unknown;
}
type Listener = (event: LiveEvent) => void;

/** Emitted by the device app each time its socket (re)opens. */
export const RECONNECTED = "__reconnected";

export function createEventBus() {
  const listeners = new Set<Listener>();
  return {
    emit(event: LiveEvent) {
      for (const listener of [...listeners]) listener(event);
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type EventBus = ReturnType<typeof createEventBus>;

export const EventBusContext = createContext<EventBus | null>(null);

/** Calls `handler` for each live event named in `names` (every event when null). */
export function useLiveEvents(names: readonly string[] | null, handler: (event: LiveEvent) => void): void {
  const bus = useContext(EventBusContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const key = names === null ? null : names.join(",");
  useEffect(() => {
    if (!bus) return undefined;
    const wanted = key === null ? null : new Set(key.split(","));
    return bus.subscribe((event) => {
      if (wanted === null || wanted.has(event.event)) handlerRef.current(event);
    });
  }, [bus, key]);
}
