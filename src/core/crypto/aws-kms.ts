import { CredentialIntegrityError } from "../errors.js";
import { loadPeer } from "../peer.js";
import { mapKmsError } from "./kms-errors.js";
import type { KeyProvider } from "./key-provider.js";

const PREFIX = "aws-kms:";
const CONTEXT_KEY = "mshindi-google";

export type AwsKmsClientLike = {
  send(
    cmd: unknown,
  ): Promise<{ CiphertextBlob?: Uint8Array; Plaintext?: Uint8Array }>;
};

type AwsKmsModule = {
  KMSClient: new () => AwsKmsClientLike;
  EncryptCommand: new (input: Record<string, unknown>) => unknown;
  DecryptCommand: new (input: Record<string, unknown>) => unknown;
};

/** Wraps DEKs with an AWS KMS symmetric key. kid is `aws-kms:<keyId>`. */
export class AwsKmsKeyProvider implements KeyProvider {
  readonly currentKeyId: string;
  readonly #keyId: string;
  #client: AwsKmsClientLike | undefined;
  #sdk: Promise<AwsKmsModule> | undefined;

  constructor(opts: { keyId: string; client?: AwsKmsClientLike }) {
    this.#keyId = opts.keyId;
    this.currentKeyId = PREFIX + opts.keyId;
    this.#client = opts.client;
  }

  // The SDK is loaded lazily; commands need it even for an injected client.
  async #load(): Promise<{ sdk: AwsKmsModule; client: AwsKmsClientLike }> {
    this.#sdk ??= loadPeer<AwsKmsModule>(
      "@aws-sdk/client-kms",
      "@aws-sdk/client-kms",
    ).catch((err) => {
      this.#sdk = undefined;
      throw err;
    });
    const sdk = await this.#sdk;
    this.#client ??= new sdk.KMSClient();
    return { sdk, client: this.#client };
  }

  async wrap(
    dek: Uint8Array,
    aad: string,
  ): Promise<{ kid: string; wdek: Uint8Array }> {
    const { sdk, client } = await this.#load();
    let res: { CiphertextBlob?: Uint8Array };
    try {
      res = await client.send(
        new sdk.EncryptCommand({
          KeyId: this.#keyId,
          Plaintext: dek,
          EncryptionContext: { [CONTEXT_KEY]: aad },
        }),
      );
    } catch (err) {
      throw mapKmsError(err);
    }
    if (!res?.CiphertextBlob || res.CiphertextBlob.length === 0) {
      throw new CredentialIntegrityError();
    }
    return { kid: this.currentKeyId, wdek: res.CiphertextBlob };
  }

  async unwrap(
    kid: string,
    wdek: Uint8Array,
    aad: string,
  ): Promise<Uint8Array> {
    if (!kid.startsWith(PREFIX) || kid.length === PREFIX.length) {
      throw new CredentialIntegrityError();
    }
    const { sdk, client } = await this.#load();
    let res: { Plaintext?: Uint8Array };
    try {
      res = await client.send(
        new sdk.DecryptCommand({
          // KeyId makes a wrong-key ciphertext fail closed.
          KeyId: kid.slice(PREFIX.length),
          CiphertextBlob: wdek,
          EncryptionContext: { [CONTEXT_KEY]: aad },
        }),
      );
    } catch (err) {
      throw mapKmsError(err);
    }
    if (!res?.Plaintext || res.Plaintext.length === 0) {
      throw new CredentialIntegrityError();
    }
    // Return the response buffer itself: the caller zeroes what it receives.
    return res.Plaintext;
  }
}
