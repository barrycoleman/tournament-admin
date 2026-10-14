/**
 * The device app's own storage and requests. It shares an origin with the
 * admin app, so it uses its own storage key and never the shared
 * apiRequest (which reads and refreshes the admin's sign-in).
 */
const STORAGE_KEY = "tournament-admin.device.v1";

export interface PairingCode {
  id: string;
  code: string;
  poll_key: string;
  expires_at: string;
  expires_in: number;
}

export interface DeviceSelf {
  id: number;
  name: string;
  role: string;
  status: "active" | "idle" | "disabled";
}

export type PollResult =
  | { status: "waiting" }
  | { status: "paired"; device_token: string }
  | { status: "expired" };

export type SignInResult =
  | { kind: "active"; accessToken: string; expiresIn: number; device: DeviceSelf }
  | { kind: "blocked"; status: "idle" | "disabled"; name: string }
  | { kind: "unknown" };

export class Unreachable extends Error {
  constructor() {
    super("Can't reach the server");
    this.name = "Unreachable";
  }
}

export function getDeviceToken(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const token = (parsed as { deviceToken?: unknown } | null)?.deviceToken;
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  }
}

export function storeDeviceToken(deviceToken: string): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ deviceToken }));
}

export function clearDeviceToken(): void {
  localStorage.removeItem(STORAGE_KEY);
}

async function send(path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new Unreachable();
  }
  if (response.status >= 500) throw new Unreachable();
  return response;
}

export async function requestPairingCode(): Promise<PairingCode> {
  const response = await send("/api/pairing", { method: "POST" });
  if (!response.ok) throw new Unreachable();
  return (await response.json()) as PairingCode;
}

export async function pollPairing(code: Pick<PairingCode, "id" | "poll_key">): Promise<PollResult> {
  const response = await send(`/api/pairing/${encodeURIComponent(code.id)}`, {
    headers: { "X-Pairing-Key": code.poll_key },
  });
  if (response.status === 404) return { status: "expired" };
  if (!response.ok) throw new Unreachable();
  return (await response.json()) as PollResult;
}

export async function signIn(deviceToken: string): Promise<SignInResult> {
  const response = await send("/api/auth/device", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_token: deviceToken }),
  });
  if (response.status === 401) return { kind: "unknown" };
  if (response.status === 403) {
    const body = (await response.json()) as { status: "idle" | "disabled"; name: string };
    return { kind: "blocked", status: body.status, name: body.name };
  }
  if (!response.ok) throw new Unreachable();
  const body = (await response.json()) as { access_token: string; expires_in: number; device: DeviceSelf };
  return { kind: "active", accessToken: body.access_token, expiresIn: body.expires_in, device: body.device };
}

export function pairingLink(origin: string, code: string): string {
  return `${origin}/devices?pair=${encodeURIComponent(code)}`;
}

export function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}
