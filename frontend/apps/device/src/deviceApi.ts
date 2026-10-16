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

// The token kept for this page's lifetime when storage refuses it (a private
// window, a full quota), so a freshly paired device still signs in. Only set
// while storage can't hold the token.
let memoryToken: string | null = null;

function readStoredToken(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const token = (parsed as { deviceToken?: unknown } | null)?.deviceToken;
    return typeof token === "string" ? token : null;
  } catch {
    // A read that throws counts as no token.
    return null;
  }
}

export function getDeviceToken(): string | null {
  return readStoredToken() ?? memoryToken;
}

/** Saves the token. A storage failure is not fatal: the token is kept in
 * memory, so this session carries on and only a reload needs pairing again. */
export function storeDeviceToken(deviceToken: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ deviceToken }));
    memoryToken = null;
  } catch {
    memoryToken = deviceToken;
  }
}

export function clearDeviceToken(): void {
  memoryToken = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing more to clear.
  }
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

/** A body that isn't the JSON we expect (an HTML page from a proxy, a cut-off
 * answer) is treated like no answer at all, so callers retry instead of
 * stalling on an error they don't expect. */
async function readJson<T>(response: Response): Promise<T> {
  try {
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object") throw new Error("not an object");
    return body as T;
  } catch {
    throw new Unreachable();
  }
}

export async function requestPairingCode(): Promise<PairingCode> {
  const response = await send("/api/pairing", { method: "POST" });
  if (!response.ok) throw new Unreachable();
  return readJson<PairingCode>(response);
}

export async function pollPairing(code: Pick<PairingCode, "id" | "poll_key">): Promise<PollResult> {
  const response = await send(`/api/pairing/${encodeURIComponent(code.id)}`, {
    headers: { "X-Pairing-Key": code.poll_key },
  });
  if (response.status === 404) return { status: "expired" };
  if (!response.ok) throw new Unreachable();
  return readJson<PollResult>(response);
}

export async function signIn(deviceToken: string): Promise<SignInResult> {
  const response = await send("/api/auth/device", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_token: deviceToken }),
  });
  if (response.status === 401) return { kind: "unknown" };
  if (response.status === 403) {
    const body = await readJson<{ status: "idle" | "disabled"; name: string }>(response);
    return { kind: "blocked", status: body.status, name: body.name };
  }
  if (!response.ok) throw new Unreachable();
  const body = await readJson<{ access_token: string; expires_in: number; device: DeviceSelf }>(response);
  return { kind: "active", accessToken: body.access_token, expiresIn: body.expires_in, device: body.device };
}

export function pairingLink(origin: string, code: string): string {
  return `${origin}/devices?pair=${encodeURIComponent(code)}`;
}

export function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/** A request the server answered with a status other than 2xx (and not 5xx,
 * which `send` already reports as Unreachable). */
export class ApiStatusError extends Error {
  status: number;

  constructor(status: number) {
    super(`The server answered ${status}`);
    this.name = "ApiStatusError";
    this.status = status;
  }
}

/** An authorized GET for display screens' data. */
export async function getJson<T>(path: string, accessToken: string): Promise<T> {
  const response = await send(path, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new ApiStatusError(response.status);
  return readJson<T>(response);
}
