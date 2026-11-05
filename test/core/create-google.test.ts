import { describe, expect, it } from "vitest";
import { InvalidConfigError } from "../../src/core/errors.js";
import { createGoogle, internals } from "../../src/core/create-google.js";
import { InMemoryStore } from "../../src/testing/in-memory-store.js";
import { LocalKeyProvider } from "../../src/testing/local-key-provider.js";

const base = () => ({
  store: new InMemoryStore(),
  keyProvider: new LocalKeyProvider(),
  callbackUrl: "https://hrms.io/cb",
});

describe("createGoogle", () => {
  it.each(["http://hrms.io/cb", "not a url", "ftp://localhost/cb"])(
    "rejects callbackUrl %s",
    (u) =>
      expect(() => createGoogle({ ...base(), callbackUrl: u })).toThrow(
        InvalidConfigError,
      ),
  );

  it.each([
    "http://localhost:3000/cb",
    "http://127.0.0.1/cb",
    "http://[::1]:3000/cb",
    "https://hrms.io/cb",
  ])("accepts %s", (u) =>
    expect(() => createGoogle({ ...base(), callbackUrl: u })).not.toThrow(),
  );

  it("exposes internals with an injected clock", () => {
    const now = () => new Date(42);
    const g = createGoogle({ ...base(), now });
    expect(g[internals].now()).toEqual(new Date(42));
    expect(g[internals].callbackUrl).toBe("https://hrms.io/cb");
  });

  it("wires a real connections api and token manager", async () => {
    const g = createGoogle(base());
    await expect(g.connections.list("t1")).resolves.toEqual([]);
    await expect(
      g[internals].tokens.getAccessToken("t", "c"),
    ).rejects.toMatchObject({ code: "connection_not_found" });
  });
});
