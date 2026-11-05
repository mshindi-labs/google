import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CredentialIntegrityError,
  InvalidConfigError,
  StaticKeyProvider,
  buildAad,
  decryptValue,
  encryptValue,
  rewrapValue,
} from "../../../src/core/index.js";

function flipFirstByte(b64url: string): string {
  const buf = Buffer.from(b64url, "base64url");
  buf[0] = (buf[0] as number) ^ 0x01;
  return buf.toString("base64url");
}

const kp = new StaticKeyProvider({
  keys: { a: randomBytes(32) },
  current: "a",
});
const aad = buildAad({
  tenantId: "t1",
  record: "connection",
  recordId: "c1",
  field: "refresh_token",
});

describe("buildAad", () => {
  it("formats AAD exactly", () =>
    expect(aad).toBe(
      "mshindi-google/v1|tenant=t1|record=connection:c1|field=refresh_token",
    ));
  it.each(["tenantId", "recordId", "field"] as const)(
    'rejects "|" and "=" in %s',
    (k) => {
      for (const bad of ["x|y", "x=y"]) {
        const p = {
          tenantId: "t",
          record: "connection" as const,
          recordId: "c",
          field: "f",
          [k]: bad,
        };
        expect(() => buildAad(p)).toThrow(InvalidConfigError);
      }
    },
  );
  it.each(["tenantId", "recordId", "field"] as const)(
    "rejects empty %s",
    (k) => {
      const p = {
        tenantId: "t",
        record: "connection" as const,
        recordId: "c",
        field: "f",
        [k]: "",
      };
      expect(() => buildAad(p)).toThrow(InvalidConfigError);
    },
  );
  it("rejects an unknown record type", () =>
    expect(() =>
      buildAad({
        tenantId: "t",
        record: "nope" as never,
        recordId: "c",
        field: "f",
      }),
    ).toThrow(InvalidConfigError));
});

describe("envelope", () => {
  it("round-trips", async () =>
    expect(
      await decryptValue(await encryptValue("1//tok", aad, kp), aad, kp),
    ).toBe("1//tok"));

  it("has the documented shape", async () => {
    const v = await encryptValue("x", aad, kp);
    expect(v.v).toBe(1);
    expect(v.kid).toBe("static:a");
    expect(Buffer.from(v.iv, "base64url")).toHaveLength(12);
    expect(Buffer.from(v.tag, "base64url")).toHaveLength(16);
  });

  it("uses a fresh DEK and IV per call", async () => {
    const [a, b] = await Promise.all([
      encryptValue("x", aad, kp),
      encryptValue("x", aad, kp),
    ]);
    expect(a.iv).not.toBe(b.iv);
    expect(a.wdek).not.toBe(b.wdek);
    expect(a.ct).not.toBe(b.ct);
  });

  it.each(["ct", "tag", "iv", "wdek"] as const)(
    "detects tampered %s",
    async (f) => {
      const v = await encryptValue("secret", aad, kp);
      await expect(
        decryptValue({ ...v, [f]: flipFirstByte(v[f]) }, aad, kp),
      ).rejects.toBeInstanceOf(CredentialIntegrityError);
    },
  );

  it("rejects unknown version and unknown kid", async () => {
    const v = await encryptValue("secret", aad, kp);
    await expect(
      decryptValue({ ...v, v: 2 as never }, aad, kp),
    ).rejects.toBeInstanceOf(CredentialIntegrityError);
    await expect(
      decryptValue({ ...v, kid: "static:zzz" }, aad, kp),
    ).rejects.toBeInstanceOf(CredentialIntegrityError);
  });

  it("rejects malformed envelopes with CredentialIntegrityError", async () => {
    await expect(decryptValue(null as never, aad, kp)).rejects.toBeInstanceOf(
      CredentialIntegrityError,
    );
  });

  it.each([
    [
      "tenant",
      {
        tenantId: "t2",
        record: "connection",
        recordId: "c1",
        field: "refresh_token",
      },
    ],
    [
      "record",
      {
        tenantId: "t1",
        record: "connection",
        recordId: "c2",
        field: "refresh_token",
      },
    ],
    [
      "field",
      {
        tenantId: "t1",
        record: "connection",
        recordId: "c1",
        field: "client_secret",
      },
    ],
  ])("fails when moved to another %s", async (_l, other) => {
    const v = await encryptValue("secret", aad, kp);
    await expect(
      decryptValue(v, buildAad(other as never), kp),
    ).rejects.toBeInstanceOf(CredentialIntegrityError);
  });

  it("failure carries no detail about which part failed", async () => {
    const v = await encryptValue("secret", aad, kp);
    const msgs = new Set<string>();
    for (const f of ["ct", "tag", "iv", "wdek"] as const) {
      try {
        await decryptValue({ ...v, [f]: flipFirstByte(v[f]) }, aad, kp);
      } catch (e) {
        msgs.add((e as Error).message);
      }
    }
    expect(msgs.size).toBe(1);
  });

  it("rewraps under the new current key and still decrypts", async () => {
    const k1 = randomBytes(32),
      k2 = randomBytes(32);
    const old = new StaticKeyProvider({ keys: { a: k1 }, current: "a" });
    const both = new StaticKeyProvider({
      keys: { a: k1, b: k2 },
      current: "b",
    });
    const v = await encryptValue("secret", aad, old);
    const r = await rewrapValue(v, aad, both);
    expect(r.kid).toBe("static:b");
    expect(r.ct).toBe(v.ct);
    expect(r.iv).toBe(v.iv);
    expect(r.tag).toBe(v.tag);
    expect(
      await decryptValue(
        r,
        aad,
        new StaticKeyProvider({ keys: { b: k2 }, current: "b" }),
      ),
    ).toBe("secret");
  });

  it("rewrap with wrong AAD fails with CredentialIntegrityError", async () => {
    const v = await encryptValue("secret", aad, kp);
    await expect(
      rewrapValue(
        v,
        buildAad({
          tenantId: "t9",
          record: "connection",
          recordId: "c1",
          field: "refresh_token",
        }),
        kp,
      ),
    ).rejects.toBeInstanceOf(CredentialIntegrityError);
  });
});
