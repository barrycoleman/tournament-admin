type Listener = (message: string | null) => void;

let currentMessage: string | null = null;
const listeners = new Set<Listener>();

/**
 * A tiny external store (not React state) so queryClient.ts — created
 * outside the component tree — can push a message that
 * TransientErrorBanner (inside AppShell) subscribes to and renders.
 * Mutations already show their own inline errors next to the form that
 * caused them; this banner is for background query failures instead
 * (e.g. a dropped connection while a page's data silently refetches).
 */
export function showTransientError(message: string): void {
  currentMessage = message;
  listeners.forEach((listener) => listener(currentMessage));
}

export function dismissTransientError(): void {
  currentMessage = null;
  listeners.forEach((listener) => listener(null));
}

export function subscribeTransientError(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTransientError(): string | null {
  return currentMessage;
}
