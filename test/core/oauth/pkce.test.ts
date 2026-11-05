import { describe, expect, it } from "vitest";
import {
  codeChallenge,
  randomToken,
  sha256,
} from "../../../src/core/oauth/pkce.js";

describe("pkce", () => {
  it("matches the RFC 7636 appendix B vector", () => {
    expect(codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
  it("randomToken is 43 url-safe chars and unique", () => {
    const a = randomToken();
    expect(a).toHaveLength(43);
    expect(a).toMatch(/^[\w-]+$/);
    expect(randomToken()).not.toBe(a);
  });
  it("sha256 returns 32 bytes", () => {
    expect(sha256("abc")).toHaveLength(32);
  });
});
