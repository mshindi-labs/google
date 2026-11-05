import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CredentialIntegrityError, InvalidConfigError } from "../errors.js";
import type { KeyProvider } from "./key-provider.js";

const PREFIX = "static:";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Wraps DEKs with AES-256-GCM under in-memory KEKs. kid is `static:<name>`. */
export class StaticKeyProvider implements KeyProvider {
  readonly currentKeyId: string;
  readonly #keys = new Map<string, Buffer>();

  constructor(opts: { keys: Record<string, Uint8Array>; current: string }) {
    for (const [name, key] of Object.entries(opts.keys)) {
      if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
        throw new InvalidConfigError(
          `StaticKeyProvider key "${name}" must be exactly ${KEY_BYTES} bytes`,
        );
      }
      this.#keys.set(PREFIX + name, Buffer.from(key));
    }
    this.currentKeyId = PREFIX + opts.current;
    if (!this.#keys.has(this.currentKeyId)) {
      throw new InvalidConfigError(
        `StaticKeyProvider current key "${opts.current}" is not in keys`,
      );
    }
  }

  async wrap(
    dek: Uint8Array,
    aad: string,
  ): Promise<{ kid: string; wdek: Uint8Array }> {
    const kek = this.#keys.get(this.currentKeyId) as Buffer;
    const iv = randomBytes(IV_BYTES);
    const c = createCipheriv("aes-256-gcm", kek, iv, {
      authTagLength: TAG_BYTES,
    });
    c.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([c.update(dek), c.final()]);
    return {
      kid: this.currentKeyId,
      wdek: new Uint8Array(Buffer.concat([iv, ct, c.getAuthTag()])),
    };
  }

  async unwrap(
    kid: string,
    wdek: Uint8Array,
    aad: string,
  ): Promise<Uint8Array> {
    try {
      const kek = this.#keys.get(kid);
      if (!kek || wdek.length !== IV_BYTES + KEY_BYTES + TAG_BYTES) {
        throw new CredentialIntegrityError();
      }
      const buf = Buffer.from(wdek);
      const d = createDecipheriv(
        "aes-256-gcm",
        kek,
        buf.subarray(0, IV_BYTES),
        {
          authTagLength: TAG_BYTES,
        },
      );
      d.setAAD(Buffer.from(aad, "utf8"));
      d.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
      const dek = Buffer.concat([
        d.update(buf.subarray(IV_BYTES, buf.length - TAG_BYTES)),
        d.final(),
      ]);
      return new Uint8Array(dek);
    } catch {
      throw new CredentialIntegrityError();
    }
  }
}
