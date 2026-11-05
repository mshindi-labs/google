import { describe, expect, it } from "vitest";
import { normalizeEmail } from "../../src/core/address.js";

describe("normalizeEmail", () => {
  it("lowercases the domain only", () =>
    expect(normalizeEmail("Ann@X.COM")).toBe("Ann@x.com"));
  it("rejects undotted domains", () =>
    expect(normalizeEmail("a@b")).toBeNull());
  it("rejects CR/LF/NUL", () => {
    expect(normalizeEmail("a\r\n@b.com")).toBeNull();
    expect(normalizeEmail("a\0@b.com")).toBeNull();
  });
  it("rejects non-strings, forbidden chars and bad shapes", () => {
    expect(normalizeEmail(42)).toBeNull();
    expect(normalizeEmail("a b@c.com")).toBeNull();
    expect(normalizeEmail("a@@c.com")).toBeNull();
    expect(normalizeEmail("@c.com")).toBeNull();
    expect(normalizeEmail("a@.com")).toBeNull();
    expect(normalizeEmail("a@c..com")).toBeNull();
    expect(normalizeEmail("a@c.com.")).toBeNull();
    expect(normalizeEmail(`${"a".repeat(250)}@b.com`)).toBeNull();
  });
});
