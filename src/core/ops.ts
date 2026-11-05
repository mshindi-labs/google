import { buildAad, decryptValue, rewrapValue } from "./crypto/envelope.js";
import type { KeyProvider } from "./crypto/key-provider.js";
import { GoogleLibError } from "./errors.js";
import type { CredentialStore } from "./store.js";
import type { EncryptedValueRef } from "./types.js";

const DEFAULT_BATCH_SIZE = 100;

export type OpsFailure = { record: string; error: string };

const label = (ref: EncryptedValueRef): string =>
  `${ref.record}:${ref.recordId}.${ref.field}`;

const aadOf = (ref: EncryptedValueRef): string =>
  buildAad({
    tenantId: ref.tenantId,
    record: ref.record,
    recordId: ref.recordId,
    field: ref.field,
  });

/** Error code only: never a message, cause, or plaintext. */
const codeOf = (err: unknown): string =>
  err instanceof GoogleLibError ? err.code : "unknown";

/**
 * Re-wraps every stored DEK under the provider's current key. Idempotent and
 * resumable: values already on the current key (or outside `fromKeyId`) are skipped.
 */
export async function rewrapAll(opts: {
  store: CredentialStore;
  keyProvider: KeyProvider;
  fromKeyId?: string;
  batchSize?: number;
}): Promise<{ rewrapped: number; skipped: number; failed: OpsFailure[] }> {
  const { store, keyProvider, fromKeyId } = opts;
  const result = {
    rewrapped: 0,
    skipped: 0,
    failed: [] as OpsFailure[],
  };
  for await (const ref of store.iterateEncryptedValues(
    opts.batchSize ?? DEFAULT_BATCH_SIZE,
  )) {
    if (
      ref.value.kid === keyProvider.currentKeyId ||
      (fromKeyId !== undefined && ref.value.kid !== fromKeyId)
    ) {
      result.skipped++;
      continue;
    }
    try {
      const next = await rewrapValue(ref.value, aadOf(ref), keyProvider);
      // A CAS miss means a concurrent writer changed it; a rerun will pick it up.
      if (await store.replaceEncryptedValue(ref, next)) result.rewrapped++;
      else result.skipped++;
    } catch (err) {
      result.failed.push({ record: label(ref), error: codeOf(err) });
    }
  }
  return result;
}

/** Fully decrypts every stored value (plaintext discarded immediately) to prove integrity. */
export async function verifyAll(opts: {
  store: CredentialStore;
  keyProvider: KeyProvider;
  batchSize?: number;
}): Promise<{ ok: number; failed: OpsFailure[] }> {
  const result = { ok: 0, failed: [] as OpsFailure[] };
  for await (const ref of opts.store.iterateEncryptedValues(
    opts.batchSize ?? DEFAULT_BATCH_SIZE,
  )) {
    try {
      await decryptValue(ref.value, aadOf(ref), opts.keyProvider);
      result.ok++;
    } catch (err) {
      result.failed.push({ record: label(ref), error: codeOf(err) });
    }
  }
  return result;
}
