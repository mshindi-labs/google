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

export type AwsKmsCommands = {
  EncryptCommand: new (input: any) => unknown;
  DecryptCommand: new (input: any) => unknown;
};

type AwsKmsModule = AwsKmsCommands & { KMSClient: new () => AwsKmsClientLike };

/** Wraps DEKs with an AWS KMS symmetric key. kid is `aws-kms:<keyId>`. */
export class AwsKmsKeyProvider implements KeyProvider {
  readonly currentKeyId: string;
  readonly #keyId: string;
  #client: AwsKmsClientLike | undefined;
  #commands: AwsKmsCommands | undefined;
  #sdk: Promise<AwsKmsModule> | undefined;

  /**
   * AWS SDK v3 `send` needs real Command instances, so the SDK is loaded
   * lazily via loadPeer only when `client` or `commands` is not injected.
   * Inject both (e.g. in tests) to avoid loading it at all.
   */
  constructor(opts: {
    keyId: string;
    client?: AwsKmsClientLike;
    commands?: AwsKmsCommands;
  }) {
    this.#keyId = opts.keyId;
    this.currentKeyId = PREFIX + opts.keyId;
    this.#client = opts.client;
    this.#commands = opts.commands;
  }

  async #load(): Promise<{
    sdk: AwsKmsCommands;
    client: AwsKmsClientLike;
  }> {
    if (this.#client && this.#commands) {
      return { sdk: this.#commands, client: this.#client };
    }
    this.#sdk ??= loadPeer<AwsKmsModule>(
      "@aws-sdk/client-kms",
      "@aws-sdk/client-kms",
    ).catch((err) => {
      this.#sdk = undefined;
      throw err;
    });
    const sdk = await this.#sdk;
    this.#commands ??= sdk;
    this.#client ??= new sdk.KMSClient();
    return { sdk: this.#commands, client: this.#client };
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
