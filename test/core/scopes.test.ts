import { describe, expect, it } from "vitest";
import {
  BASE_SCOPES,
  SERVICE_SCOPES,
  assertServiceScopes,
  scopesFor,
} from "../../src/core/scopes.js";

const SEND = "https://www.googleapis.com/auth/gmail.send";

const CAL = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
];

describe("scopes", () => {
  it("scopesFor(calendar) adds the two calendar scopes", () =>
    expect(scopesFor(["calendar"])).toEqual(["openid", "email", ...CAL]));

  it("assertServiceScopes lists both missing calendar scopes", () =>
    expect(() => assertServiceScopes([SEND], ["calendar"])).toThrow(
      expect.objectContaining({ code: "missing_scope", required: CAL }),
    ));

  it("scopesFor returns base plus service scopes without duplicates", () => {
    expect(scopesFor(["gmail", "gmail"])).toEqual([...BASE_SCOPES, SEND]);
    expect(SERVICE_SCOPES.gmail).toEqual([SEND]);
  });

  it("scopesFor with no services returns the base scopes", () =>
    expect(scopesFor([])).toEqual(["openid", "email"]));

  it("ignores userinfo.email alias and base scopes", () =>
    expect(() =>
      assertServiceScopes(
        ["openid", "https://www.googleapis.com/auth/userinfo.email", SEND],
        ["gmail"],
      ),
    ).not.toThrow());

  it("lists missing service scopes", () =>
    expect(() => assertServiceScopes(["openid", "email"], ["gmail"])).toThrow(
      expect.objectContaining({ code: "missing_scope", required: [SEND] }),
    ));

  it("attaches tenant and connection ids to the error", () => {
    try {
      assertServiceScopes([], ["gmail"], {
        tenantId: "t1",
        connectionId: "c1",
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ tenantId: "t1", connectionId: "c1" });
    }
  });
});
