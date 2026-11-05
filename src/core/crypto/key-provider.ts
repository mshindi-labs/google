export interface KeyProvider {
  readonly currentKeyId: string;
  wrap(
    dek: Uint8Array,
    aad: string,
  ): Promise<{ kid: string; wdek: Uint8Array }>;
  unwrap(kid: string, wdek: Uint8Array, aad: string): Promise<Uint8Array>;
}
