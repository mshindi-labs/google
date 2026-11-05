import { describe, expect, it } from "vitest";
import { loadPeer } from "../../src/core/peer.js";

describe("loadPeer", () => {
  it("throws MissingPeerDependencyError with install hint", async () => {
    await expect(
      loadPeer("definitely-not-installed-pkg"),
    ).rejects.toMatchObject({
      code: "missing_peer_dependency",
      peer: "definitely-not-installed-pkg",
      message: expect.stringContaining("npm i definitely-not-installed-pkg"),
    });
  });

  it("uses installName for the hint when given", async () => {
    await expect(
      loadPeer(
        "definitely-not-installed-pkg/sub",
        "definitely-not-installed-pkg",
      ),
    ).rejects.toMatchObject({
      peer: "definitely-not-installed-pkg",
      message: expect.stringContaining("npm i definitely-not-installed-pkg"),
    });
  });

  it("loads an installed module", async () => {
    const mod = await loadPeer<typeof import("node:path")>("node:path");
    expect(typeof mod.join).toBe("function");
  });

  it("does not mask a missing transitive import inside an installed module", async () => {
    const fixture = new URL("./fixtures/imports-missing.mjs", import.meta.url)
      .href;
    const err = await loadPeer(fixture).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).not.toBe("missing_peer_dependency");
  });
});
