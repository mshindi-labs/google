import { describe, expect, it } from "vitest";
import { redact } from "../../src/core/redact.js";

describe("redact", () => {
  it.each([
    ["access token", "Bearer ya29.a0AfB_x-Y_z", "ya29.a0AfB_x-Y_z"],
    ["refresh token", "rt=1//0gAbC-dEf_123", "1//0gAbC-dEf_123"],
    ["client secret", "GOCSPX-AbCdEf123_-x", "GOCSPX-AbCdEf123_-x"],
    ["json field", '{"refresh_token":"opaque-value"}', "opaque-value"],
    ["json field", '{"client_secret":"s3cr3t"}', "s3cr3t"],
    ["json field", '{"id_token":"eyJhbGc.x.y"}', "eyJhbGc.x.y"],
    ["query code", "GET /cb?code=4/0AY0e-g7&state=x", "4/0AY0e-g7"],
  ])("removes %s", (_label, input, secret) => {
    const out = redact(input);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });

  it("leaves ordinary text alone", () =>
    expect(redact("hello careers@x.io")).toBe("hello careers@x.io"));

  it("keeps surrounding context", () => {
    expect(redact("GET /cb?code=abc&state=x")).toBe(
      "GET /cb?code=[REDACTED]&state=x",
    );
  });
});
