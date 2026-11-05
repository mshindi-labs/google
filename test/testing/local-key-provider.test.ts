import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidConfigError } from "../../src/core/index.js";
import { LocalKeyProvider } from "../../src/testing/index.js";

afterEach(() => vi.unstubAllEnvs());

describe("LocalKeyProvider", () => {
  it("generates a random key with kid static:local", async () => {
    const kp = new LocalKeyProvider();
    expect(kp.currentKeyId).toBe("static:local");
    const dek = randomBytes(32);
    const w = await kp.wrap(dek, "a");
    expect(Buffer.from(await kp.unwrap(w.kid, w.wdek, "a")).equals(dek)).toBe(
      true,
    );
  });
  it("accepts an explicit key", async () => {
    const key = randomBytes(32);
    const a = new LocalKeyProvider({ key });
    const b = new LocalKeyProvider({ key });
    const w = await a.wrap(randomBytes(32), "a");
    await expect(b.unwrap(w.kid, w.wdek, "a")).resolves.toHaveLength(32);
  });
  it("refuses production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => new LocalKeyProvider()).toThrow(InvalidConfigError);
    expect(
      () => new LocalKeyProvider({ allowInProduction: true }),
    ).not.toThrow();
  });
});
