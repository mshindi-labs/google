import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CredentialIntegrityError, InvalidConfigError } from "../errors.js";
import type { KeyProvider } from "./key-provider.js";

export type EncryptedValue = {
  v: 1;
  kid: string;
  wdek: string;
  iv: string;
  ct: string;
  tag: string;
};

export type AadRecord = "oauth_client" | "connection" | "oauth_state";

const RECORDS: readonly string[] = [
  "oauth_client",
  "connection",
  "oauth_state",
];
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;

function part(name: string, value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidConfigError(`AAD ${name} must be a non-empty string`);
  }
  if (value.includes("|") || value.includes("=")) {
    throw new InvalidConfigError(`AAD ${name} must not contain "|" or "="`);
  }
  return value;
}

export function buildAad(p: {
  tenantId: string;
  record: AadRecord;
  recordId: string;
  field: string;
}): string {
  if (!RECORDS.includes(p.record)) {
    throw new InvalidConfigError(`Unknown AAD record type`);
  }
  return `mshindi-google/v1|tenant=${part("tenantId", p.tenantId)}|record=${p.record}:${part("recordId", p.recordId)}|field=${part("field", p.field)}`;
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const unb64 = (s: string): Buffer => {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new CredentialIntegrityError();
  }
  const decoded = Buffer.from(s, "base64url");
  // Reject non-canonical encodings (e.g. nonzero trailing bits).
  if (decoded.toString("base64url") !== s) throw new CredentialIntegrityError();
  return decoded;
};

export async function encryptValue(
  plaintext: string,
  aad: string,
  kp: KeyProvider,
): Promise<EncryptedValue> {
  const dek = randomBytes(DEK_BYTES);
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", dek, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const { kid, wdek } = await kp.wrap(dek, aad);
    return {
      v: 1,
      kid,
      wdek: b64(wdek),
      iv: b64(iv),
      ct: b64(ct),
      tag: b64(tag),
    };
  } finally {
    dek.fill(0);
  }
}

export async function decryptValue(
  value: EncryptedValue,
  aad: string,
  kp: KeyProvider,
): Promise<string> {
  let dek: Uint8Array | undefined;
  try {
    if (!value || value.v !== 1) throw new CredentialIntegrityError();
    dek = await kp.unwrap(value.kid, unb64(value.wdek), aad);
    const iv = unb64(value.iv);
    const tag = unb64(value.tag);
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new CredentialIntegrityError();
    }
    const decipher = createDecipheriv("aes-256-gcm", dek, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(unb64(value.ct)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Deliberately detail-free: never reveal which part failed.
    throw new CredentialIntegrityError();
  } finally {
    dek?.fill(0);
  }
}

export async function rewrapValue(
  value: EncryptedValue,
  aad: string,
  kp: KeyProvider,
): Promise<EncryptedValue> {
  let dek: Uint8Array | undefined;
  try {
    if (!value || value.v !== 1) throw new CredentialIntegrityError();
    dek = await kp.unwrap(value.kid, unb64(value.wdek), aad);
    const { kid, wdek } = await kp.wrap(dek, aad);
    return { ...value, kid, wdek: b64(wdek) };
  } catch {
    throw new CredentialIntegrityError();
  } finally {
    dek?.fill(0);
  }
}
