import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const peer = vi.hoisted(() => ({ loadPeer: vi.fn() }));
vi.mock("../../../src/core/peer.js", () => peer);

import {
  AwsKmsKeyProvider,
  buildAad,
  CredentialIntegrityError,
  decryptValue,
  encryptValue,
  GcpKmsKeyProvider,
  KeyProviderUnavailableError,
  MissingPeerDependencyError,
  rewrapValue,
  type AwsKmsClientLike,
  type GcpKmsClientLike,
} from "../../../src/core/index.js";

const KEK = randomBytes(32);
const xor = (b: Uint8Array): Uint8Array =>
  Uint8Array.from(b, (x, i) => x ^ KEK[i % 32]!);
const aadOf = () =>
  buildAad({
    tenantId: "t1",
    record: "connection",
    recordId: "c1",
    field: "rt",
  });

class FakeCmd {
  constructor(readonly input: Record<string, unknown>) {}
}
class EncryptCommand extends FakeCmd {}
class DecryptCommand extends FakeCmd {}

function gcpFake(opts: { reject?: unknown; empty?: boolean } = {}) {
  const reqs: Record<string, any>[] = [];
  const client: GcpKmsClientLike = {
    async encrypt(req) {
      reqs.push(req);
      if (opts.reject) throw opts.reject;
      if (opts.empty) return [{}];
      const tagged = Buffer.concat([
        Buffer.from(req.additionalAuthenticatedData),
        Buffer.from([0xff]),
        xor(req.plaintext),
      ]);
      return [{ ciphertext: tagged }];
    },
    async decrypt(req) {
      reqs.push(req);
      if (opts.reject) throw opts.reject;
      const buf = Buffer.from(req.ciphertext);
      const sep = buf.indexOf(0xff);
      const aad = buf.subarray(0, sep);
      if (!aad.equals(Buffer.from(req.additionalAuthenticatedData))) {
        throw { code: 3 };
      }
      return [{ plaintext: xor(buf.subarray(sep + 1)) }];
    },
  };
  return { client, reqs };
}

function awsFake(opts: { reject?: unknown; empty?: boolean } = {}) {
  const cmds: FakeCmd[] = [];
  const client: AwsKmsClientLike = {
    async send(cmd) {
      const c = cmd as FakeCmd;
      cmds.push(c);
      if (opts.reject) throw opts.reject;
      if (opts.empty) return {};
      const ctx = JSON.stringify(c.input.EncryptionContext);
      if (c instanceof EncryptCommand) {
        const blob = Buffer.concat([
          Buffer.from(ctx),
          Buffer.from([0xff]),
          xor(c.input.Plaintext as Uint8Array),
        ]);
        return { CiphertextBlob: blob };
      }
      const buf = Buffer.from(c.input.CiphertextBlob as Uint8Array);
      const sep = buf.indexOf(0xff);
      if (buf.subarray(0, sep).toString() !== ctx) {
        throw Object.assign(new Error("x"), {
          name: "InvalidCiphertextException",
        });
      }
      return { Plaintext: xor(buf.subarray(sep + 1)) };
    },
  };
  return { client, cmds };
}

beforeEach(() => {
  peer.loadPeer.mockReset();
  peer.loadPeer.mockResolvedValue({
    EncryptCommand,
    DecryptCommand,
    KMSClient: class {},
  });
});

describe("GcpKmsKeyProvider", () => {
  const keyName = "projects/p/locations/l/keyRings/r/cryptoKeys/k";

  it("has kid gcp-kms:<keyName>", () =>
    expect(
      new GcpKmsKeyProvider({ keyName, client: gcpFake().client }).currentKeyId,
    ).toBe(`gcp-kms:${keyName}`));

  it("passes AAD as additionalAuthenticatedData (GCP)", async () => {
    const { client, reqs } = gcpFake();
    const kp = new GcpKmsKeyProvider({ keyName, client });
    const aad = aadOf();
    await kp.wrap(randomBytes(32), aad);
    expect(Buffer.from(reqs[0]!.additionalAuthenticatedData)).toEqual(
      Buffer.from(aad),
    );
    expect(reqs[0]!.name).toBe(keyName);
  });

  it("round-trips through encryptValue/decryptValue", async () => {
    const kp = new GcpKmsKeyProvider({ keyName, client: gcpFake().client });
    const aad = aadOf();
    const enc = await encryptValue("secret", aad, kp);
    expect(enc.kid).toBe(`gcp-kms:${keyName}`);
    expect(await decryptValue(enc, aad, kp)).toBe("secret");
    const re = await rewrapValue(enc, aad, kp);
    expect(await decryptValue(re, aad, kp)).toBe("secret");
  });

  it("maps client errors to CredentialIntegrityError on unwrap", async () => {
    const kp = new GcpKmsKeyProvider({ keyName, client: gcpFake().client });
    const aad = aadOf();
    const enc = await encryptValue("secret", aad, kp);
    await expect(decryptValue(enc, aad + "x", kp)).rejects.toBeInstanceOf(
      CredentialIntegrityError,
    );
    const bad = new GcpKmsKeyProvider({
      keyName,
      client: gcpFake({ reject: { code: 3 } }).client,
    });
    await expect(decryptValue(enc, aad, bad)).rejects.toBeInstanceOf(
      CredentialIntegrityError,
    );
    await expect(
      bad.unwrap(enc.kid, Buffer.from(enc.wdek, "base64url"), aad),
    ).rejects.toBeInstanceOf(CredentialIntegrityError);
  });

  it("maps UNAVAILABLE (14) to KeyProviderUnavailableError via decryptValue", async () => {
    const aad = aadOf();
    const enc = await encryptValue(
      "s",
      aad,
      new GcpKmsKeyProvider({ keyName, client: gcpFake().client }),
    );
    for (const reject of [
      { code: 14 },
      { code: 4 },
      { code: 8 },
      { code: "ECONNRESET" },
    ]) {
      const kp = new GcpKmsKeyProvider({
        keyName,
        client: gcpFake({ reject }).client,
      });
      await expect(decryptValue(enc, aad, kp)).rejects.toBeInstanceOf(
        KeyProviderUnavailableError,
      );
      await expect(rewrapValue(enc, aad, kp)).rejects.toBeInstanceOf(
        KeyProviderUnavailableError,
      );
    }
  });

  it("wrap fails closed on missing ciphertext and maps errors", async () => {
    const dek = randomBytes(32);
    await expect(
      new GcpKmsKeyProvider({
        keyName,
        client: gcpFake({ empty: true }).client,
      }).wrap(dek, "a"),
    ).rejects.toBeInstanceOf(CredentialIntegrityError);
    await expect(
      new GcpKmsKeyProvider({
        keyName,
        client: gcpFake({ reject: { code: 14 } }).client,
      }).wrap(dek, "a"),
    ).rejects.toBeInstanceOf(KeyProviderUnavailableError);
    await expect(
      new GcpKmsKeyProvider({
        keyName,
        client: gcpFake({ reject: { code: 7 } }).client,
      }).wrap(dek, "a"),
    ).rejects.toBeInstanceOf(CredentialIntegrityError);
  });

  it("unwrap returns the response buffer itself and rejects foreign kids", async () => {
    const plain = Buffer.from(randomBytes(32));
    const client: GcpKmsClientLike = {
      encrypt: async () => [{ ciphertext: Buffer.from("x") }],
      decrypt: async () => [{ plaintext: plain }],
    };
    const kp = new GcpKmsKeyProvider({ keyName, client });
    expect(await kp.unwrap(`gcp-kms:${keyName}`, Buffer.from("x"), "a")).toBe(
      plain,
    );
    await expect(
      kp.unwrap("aws-kms:k", Buffer.from("x"), "a"),
    ).rejects.toBeInstanceOf(CredentialIntegrityError);
  });

  it("lazy-loads the SDK only when no client is injected", async () => {
    await new GcpKmsKeyProvider({ keyName, client: gcpFake().client }).wrap(
      randomBytes(32),
      "a",
    );
    expect(peer.loadPeer).not.toHaveBeenCalled();
    peer.loadPeer.mockRejectedValue(
      new MissingPeerDependencyError("@google-cloud/kms"),
    );
    const kp = new GcpKmsKeyProvider({ keyName });
    await expect(kp.wrap(randomBytes(32), "a")).rejects.toMatchObject({
      name: "MissingPeerDependencyError",
      peer: "@google-cloud/kms",
    });
    expect(peer.loadPeer).toHaveBeenCalledWith(
      "@google-cloud/kms",
      "@google-cloud/kms",
    );
  });

  it("creates the SDK client once when none is injected", async () => {
    const { client } = gcpFake();
    const ctor = vi.fn(() => client);
    peer.loadPeer.mockResolvedValue({ KeyManagementServiceClient: ctor });
    const kp = new GcpKmsKeyProvider({ keyName });
    await kp.wrap(randomBytes(32), "a");
    await kp.wrap(randomBytes(32), "a");
    expect(ctor).toHaveBeenCalledTimes(1);
  });
});

describe("AwsKmsKeyProvider", () => {
  const keyId = "arn:aws:kms:eu-west-1:111122223333:key/abc";

  it("has kid aws-kms:<keyId>", () =>
    expect(
      new AwsKmsKeyProvider({ keyId, client: awsFake().client }).currentKeyId,
    ).toBe(`aws-kms:${keyId}`));

  it('passes AAD as EncryptionContext { "mshindi-google": aad } (AWS)', async () => {
    const { client, cmds } = awsFake();
    const kp = new AwsKmsKeyProvider({ keyId, client });
    const aad = aadOf();
    const enc = await encryptValue("secret", aad, kp);
    expect(cmds[0]).toBeInstanceOf(EncryptCommand);
    expect(cmds[0]!.input.EncryptionContext).toEqual({ "mshindi-google": aad });
    expect(cmds[0]!.input.KeyId).toBe(keyId);
    await decryptValue(enc, aad, kp);
    expect(cmds[1]).toBeInstanceOf(DecryptCommand);
    expect(cmds[1]!.input.EncryptionContext).toEqual({ "mshindi-google": aad });
    expect(cmds[1]!.input.KeyId).toBe(keyId);
  });

  it("round-trips through encryptValue/decryptValue", async () => {
    const kp = new AwsKmsKeyProvider({ keyId, client: awsFake().client });
    const aad = aadOf();
    const enc = await encryptValue("secret", aad, kp);
    expect(await decryptValue(enc, aad, kp)).toBe("secret");
    expect(await decryptValue(await rewrapValue(enc, aad, kp), aad, kp)).toBe(
      "secret",
    );
  });

  it("maps client errors to CredentialIntegrityError on unwrap", async () => {
    const kp = new AwsKmsKeyProvider({ keyId, client: awsFake().client });
    const aad = aadOf();
    const enc = await encryptValue("secret", aad, kp);
    await expect(decryptValue(enc, aad + "x", kp)).rejects.toBeInstanceOf(
      CredentialIntegrityError,
    );
  });

  it("maps availability failures to KeyProviderUnavailableError", async () => {
    const aad = aadOf();
    const enc = await encryptValue(
      "s",
      aad,
      new AwsKmsKeyProvider({ keyId, client: awsFake().client }),
    );
    const rejects = [
      Object.assign(new Error("slow down"), { name: "ThrottlingException" }),
      Object.assign(new Error("t"), { name: "TimeoutError" }),
      Object.assign(new Error("5xx"), { $metadata: { httpStatusCode: 503 } }),
      Object.assign(new Error("net"), { code: "ETIMEDOUT" }),
    ];
    for (const reject of rejects) {
      const kp = new AwsKmsKeyProvider({
        keyId,
        client: awsFake({ reject }).client,
      });
      await expect(decryptValue(enc, aad, kp)).rejects.toBeInstanceOf(
        KeyProviderUnavailableError,
      );
    }
    const denied = Object.assign(new Error("no"), {
      name: "AccessDeniedException",
      $metadata: { httpStatusCode: 400 },
    });
    await expect(
      decryptValue(
        enc,
        aad,
        new AwsKmsKeyProvider({
          keyId,
          client: awsFake({ reject: denied }).client,
        }),
      ),
    ).rejects.toBeInstanceOf(CredentialIntegrityError);
  });

  it("wrap fails closed on missing CiphertextBlob and maps errors", async () => {
    const dek = randomBytes(32);
    await expect(
      new AwsKmsKeyProvider({
        keyId,
        client: awsFake({ empty: true }).client,
      }).wrap(dek, "a"),
    ).rejects.toBeInstanceOf(CredentialIntegrityError);
    await expect(
      new AwsKmsKeyProvider({
        keyId,
        client: awsFake({
          reject: Object.assign(new Error("t"), {
            name: "ThrottlingException",
          }),
        }).client,
      }).wrap(dek, "a"),
    ).rejects.toBeInstanceOf(KeyProviderUnavailableError);
  });

  it("unwrap fails closed on missing Plaintext and returns the buffer itself", async () => {
    const kp0 = new AwsKmsKeyProvider({
      keyId,
      client: awsFake({ empty: true }).client,
    });
    await expect(
      kp0.unwrap(`aws-kms:${keyId}`, Buffer.from("x"), "a"),
    ).rejects.toBeInstanceOf(CredentialIntegrityError);
    const plain = Buffer.from(randomBytes(32));
    const kp = new AwsKmsKeyProvider({
      keyId,
      client: { send: async () => ({ Plaintext: plain }) },
    });
    expect(await kp.unwrap(`aws-kms:${keyId}`, Buffer.from("x"), "a")).toBe(
      plain,
    );
    await expect(
      kp.unwrap("gcp-kms:k", Buffer.from("x"), "a"),
    ).rejects.toBeInstanceOf(CredentialIntegrityError);
  });

  it("lazy-loads the SDK only when needed", async () => {
    peer.loadPeer.mockRejectedValue(
      new MissingPeerDependencyError("@aws-sdk/client-kms"),
    );
    const kp = new AwsKmsKeyProvider({ keyId });
    await expect(kp.wrap(randomBytes(32), "a")).rejects.toMatchObject({
      name: "MissingPeerDependencyError",
      peer: "@aws-sdk/client-kms",
    });
    expect(peer.loadPeer).toHaveBeenCalledWith(
      "@aws-sdk/client-kms",
      "@aws-sdk/client-kms",
    );
  });
});
