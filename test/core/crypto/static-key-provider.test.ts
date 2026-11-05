import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CredentialIntegrityError,
  InvalidConfigError,
  StaticKeyProvider,
} from "../../../src/core/index.js";

describe("StaticKeyProvider", () => {
  it("rejects non-32-byte keys and unknown current", () => {
    expect(
      () =>
        new StaticKeyProvider({ keys: { a: randomBytes(16) }, current: "a" }),
    ).toThrow(InvalidConfigError);
    expect(
      () =>
        new StaticKeyProvider({ keys: { a: randomBytes(32) }, current: "z" }),
    ).toThrow(InvalidConfigError);
  });

  it("currentKeyId is the full kid", () =>
    expect(
      new StaticKeyProvider({ keys: { a: randomBytes(32) }, current: "a" })
        .currentKeyId,
    ).toBe("static:a"));

  it("wraps to iv(12)+ct(32)+tag(16) and unwraps", async () => {
    const kp = new StaticKeyProvider({
      keys: { a: randomBytes(32) },
      current: "a",
    });
    const dek = randomBytes(32);
    const { kid, wdek } = await kp.wrap(dek, "aad");
    expect(kid).toBe("static:a");
    expect(wdek).toHaveLength(60);
    expect(Buffer.from(await kp.unwrap(kid, wdek, "aad")).equals(dek)).toBe(
      true,
    );
  });

  it("unwrap fails on wrong aad, unknown kid, wrong length", async () => {
    const kp = new StaticKeyProvider({
      keys: { a: randomBytes(32) },
      current: "a",
    });
    const { kid, wdek } = await kp.wrap(randomBytes(32), "aad");
    await expect(kp.unwrap(kid, wdek, "other")).rejects.toBeInstanceOf(
      CredentialIntegrityError,
    );
    await expect(kp.unwrap("static:q", wdek, "aad")).rejects.toBeInstanceOf(
      CredentialIntegrityError,
    );
    await expect(kp.unwrap("gcp:x", wdek, "aad")).rejects.toBeInstanceOf(
      CredentialIntegrityError,
    );
    await expect(
      kp.unwrap(kid, wdek.subarray(1), "aad"),
    ).rejects.toBeInstanceOf(CredentialIntegrityError);
  });

  it("copies key material so later caller mutation has no effect", async () => {
    const key = randomBytes(32);
    const kp = new StaticKeyProvider({ keys: { a: key }, current: "a" });
    const { kid, wdek } = await kp.wrap(randomBytes(32), "aad");
    key.fill(0);
    await expect(kp.unwrap(kid, wdek, "aad")).resolves.toHaveLength(32);
  });
});
