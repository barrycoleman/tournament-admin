import { describe, expect, it } from "vitest";
import { decodeAccessTokenPayload } from "../src/jwt";

function base64url(input: object): string {
  const json = JSON.stringify(input);
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeJwt(payload: object): string {
  const header = base64url({ alg: "HS256", typ: "JWT" });
  const body = base64url(payload);
  // Decoding never verifies the signature client-side, so any
  // third segment is fine for this test.
  return `${header}.${body}.unsigned`;
}

describe("decodeAccessTokenPayload", () => {
  it("decodes the role, iat, and exp claims without verifying the signature", () => {
    const token = fakeJwt({ role: "admin", iat: 1000, exp: 2800 });
    expect(decodeAccessTokenPayload(token)).toEqual({
      role: "admin",
      iat: 1000,
      exp: 2800,
    });
  });

  it("throws on a malformed token", () => {
    expect(() => decodeAccessTokenPayload("not-a-jwt")).toThrow();
  });
});
