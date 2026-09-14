export interface AccessTokenPayload {
  role: string;
  iat: number;
  exp: number;
}

/**
 * Decodes (without verifying) the payload of a JWT access token, purely
 * for client-side display (e.g. showing the current role in the UI).
 * The server is the only party that verifies the signature; every
 * real request is independently bearer-token and role gated there.
 */
export function decodeAccessTokenPayload(accessToken: string): AccessTokenPayload {
  const parts = accessToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed access token");
  }
  const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const json = atob(padded);
  return JSON.parse(json) as AccessTokenPayload;
}
