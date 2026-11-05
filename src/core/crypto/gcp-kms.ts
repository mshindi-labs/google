import { CredentialIntegrityError } from "../errors.js";
import { loadPeer } from "../peer.js";
import { mapKmsError } from "./kms-errors.js";
import type { KeyProvider } from "./key-provider.js";

const PREFIX = "gcp-kms:";

export type GcpKmsClientLike = {
  encrypt(req: {
    name: string;
    plaintext: Uint8Array;
    additionalAuthenticatedData: Uint8Array;
  }): Promise<[{ ciphertext?: Uint8Array | string | null }]>;
  decrypt(req: {
    name: string;
    ciphertext: Uint8Array;
    additionalAuthenticatedData: Uint8Array;
  }): Promise<[{ plaintext?: Uint8Array | string | null }]>;
};

/** Wraps DEKs with a Cloud KMS symmetric key. kid is `gcp-kms:<keyName>`. */
export class GcpKmsKeyProvider implements KeyProvider {
  readonly currentKeyId: string;
  readonly #keyName: string;
  #client: GcpKmsClientLike | undefined;
  #loading: Promise<GcpKmsClientLike> | undefined;

  constructor(opts: { keyName: string; client?: GcpKmsClientLike }) {
    this.#keyName = opts.keyName;
    this.currentKeyId = PREFIX + opts.keyName;
    this.#client = opts.client;
  }

  async #getClient(): Promise<GcpKmsClientLike> {
    if (this.#client) return this.#client;
    this.#loading ??= loadPeer<{
      KeyManagementServiceClient: new () => GcpKmsClientLike;
    }>("@google-cloud/kms", "@google-cloud/kms").then(
      (m) => (this.#client = new m.KeyManagementServiceClient()),
      (err) => {
        this.#loading = undefined;
        throw err;
      },
    );
    return this.#loading;
  }

  async wrap(
    dek: Uint8Array,
    aad: string,
  ): Promise<{ kid: string; wdek: Uint8Array }> {
    const client = await this.#getClient();
    let res: [{ ciphertext?: Uint8Array | string | null }];
    try {
      res = await client.encrypt({
        name: this.#keyName,
        plaintext: dek,
        additionalAuthenticatedData: Buffer.from(aad, "utf8"),
      });
    } catch (err) {
      throw mapKmsError(err);
    }
    const ciphertext = res?.[0]?.ciphertext;
    if (ciphertext == null || ciphertext.length === 0) {
      throw new CredentialIntegrityError();
    }
    return { kid: this.currentKeyId, wdek: toBytes(ciphertext) };
  }

  async unwrap(
    kid: string,
    wdek: Uint8Array,
    aad: string,
  ): Promise<Uint8Array> {
    if (!kid.startsWith(PREFIX) || kid.length === PREFIX.length) {
      throw new CredentialIntegrityError();
    }
    const client = await this.#getClient();
    let res: [{ plaintext?: Uint8Array | string | null }];
    try {
      res = await client.decrypt({
        name: kid.slice(PREFIX.length),
        ciphertext: wdek,
        additionalAuthenticatedData: Buffer.from(aad, "utf8"),
      });
    } catch (err) {
      throw mapKmsError(err);
    }
    const plaintext = res?.[0]?.plaintext;
    if (plaintext == null || plaintext.length === 0) {
      throw new CredentialIntegrityError();
    }
    // Return the response buffer itself: the caller zeroes what it receives.
    return toBytes(plaintext);
  }
}

function toBytes(v: Uint8Array | string): Uint8Array {
  return typeof v === "string" ? Buffer.from(v, "base64") : v;
}
