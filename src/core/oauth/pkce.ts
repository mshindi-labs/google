import { createHash, randomBytes } from "node:crypto";

/** 32 random bytes, base64url (43 chars). */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(input: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(input).digest());
}

/** PKCE S256 code challenge for a verifier. */
export function codeChallenge(verifier: string): string {
  return Buffer.from(sha256(verifier)).toString("base64url");
}
