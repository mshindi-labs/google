import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INIT_SQL_TEMPLATE,
  getMigrations,
} from "../../src/postgres/migrations.js";
import { InvalidConfigError } from "../../src/core/errors.js";

describe("postgres migrations", () => {
  it("embedded SQL constant equals the .sql file", () => {
    const file = readFileSync(
      new URL("../../src/postgres/sql/0001_init.sql", import.meta.url),
      "utf8",
    );
    expect(INIT_SQL_TEMPLATE).toBe(file);
    expect(file).toContain("{{schema}}");
    expect(file).toContain("{{prefix}}");
  });

  it("returns 0001_init with defaults substituted", () => {
    const m = getMigrations();
    expect(m.map((x) => x.id)).toEqual(["0001_init"]);
    expect(m[0]!.sql).toContain('"public"."google_connections"');
    expect(m[0]!.sql).not.toContain("{{");
  });

  it("substitutes custom schema/prefix and rejects unsafe identifiers", () => {
    expect(
      getMigrations({ schema: "app", tablePrefix: "g_" })[0]!.sql,
    ).toContain('"app"."g_oauth_states"');
    expect(() => getMigrations({ schema: "public; drop" })).toThrow(
      InvalidConfigError,
    );
    expect(() => getMigrations({ tablePrefix: "Bad" })).toThrow(
      InvalidConfigError,
    );
  });
});
