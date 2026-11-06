import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Requires `npm run build` first (see the test:package script).
const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist");
const load = (name: string): Promise<Record<string, unknown>> =>
  import(resolve(dist, `${name}.js`));
const names = (mod: Record<string, unknown>): string[] =>
  Object.keys(mod).sort();
const require = createRequire(import.meta.url);

const TEST_ONLY = [
  "InMemoryStore",
  "LocalKeyProvider",
  "FakeGoogleOAuth",
  "CaptureTransport",
  "runStoreContractTests",
];

describe("package exports", () => {
  it("/core", async () => {
    expect(names(await load("core"))).toMatchInlineSnapshot(`
      [
        "AwsKmsKeyProvider",
        "BASE_SCOPES",
        "ConferencingUnavailableError",
        "ConnectionNotFoundError",
        "ConnectionRevokedError",
        "CredentialIntegrityError",
        "DailyQuotaExceededError",
        "EventCancelledError",
        "EventConflictError",
        "EventNotFoundError",
        "EventNotManagedError",
        "GcpKmsKeyProvider",
        "GoogleApiError",
        "GoogleLibError",
        "InvalidConfigError",
        "InvalidEventError",
        "InvalidGrantError",
        "InvalidMessageError",
        "InvalidOAuthStateError",
        "KeyProviderUnavailableError",
        "MessageTooLargeError",
        "MissingPeerDependencyError",
        "MissingScopeError",
        "NoRefreshTokenError",
        "OAuthClientNotConfiguredError",
        "OAuthConsentDeniedError",
        "RateLimitedError",
        "SERVICE_SCOPES",
        "SendOutcomeUnknownError",
        "StaticKeyProvider",
        "UnexpectedAccountError",
        "createGoogle",
        "rewrapAll",
        "scopesFor",
        "verifyAll",
      ]
    `);
  });

  it("/core types export GoogleErrorOptions, not the global-shadowing ErrorOptions", () => {
    for (const ext of ["d.ts", "d.cts"]) {
      const dts = readFileSync(resolve(dist, `core.${ext}`), "utf8");
      const exported = dts.match(/^export \{[^}]*\};$/gm)?.join(" ") ?? "";
      expect(exported).toMatch(/\btype GoogleErrorOptions\b/);
      expect(dts).not.toMatch(/\bErrorOptions\b/);
    }
  });

  it("/gmail", async () => {
    const mod = await load("gmail");
    expect(names(mod)).toMatchInlineSnapshot(`
      [
        "MAX_ATTACHMENT_BYTES",
        "UPLOAD_THRESHOLD_BYTES",
        "createGmail",
        "createGmailApiTransport",
      ]
    `);
    expect(mod).not.toHaveProperty("SendUnauthorizedSignal");
    expect(mod).not.toHaveProperty("withSendRetry");
    expect(mod).not.toHaveProperty("InvalidGrantError");
  });

  it("/postgres", async () => {
    expect(names(await load("postgres"))).toMatchInlineSnapshot(`
      [
        "createPostgresStore",
        "fromPrisma",
        "fromTypeOrm",
        "getMigrations",
      ]
    `);
  });

  it("/testing", async () => {
    expect(names(await load("testing"))).toMatchInlineSnapshot(`
      [
        "CaptureTransport",
        "FakeCalendar",
        "FakeGoogleOAuth",
        "InMemoryStore",
        "LocalKeyProvider",
        "runStoreContractTests",
      ]
    `);
  });

  it("test-only helpers ship only in /testing", async () => {
    for (const entry of ["core", "gmail", "postgres"]) {
      const exported = names(await load(entry));
      for (const name of TEST_ONLY) expect(exported).not.toContain(name);
    }
    const testing = names(await load("testing"));
    for (const name of TEST_ONLY) expect(testing).toContain(name);
  });

  it("every entry loads through require() with matching names", async () => {
    for (const entry of ["core", "gmail", "postgres", "testing"]) {
      const cjs = require(resolve(dist, `${entry}.cjs`)) as Record<
        string,
        unknown
      >;
      expect(names(cjs)).toEqual(names(await load(entry)));
    }
    expect(typeof require(resolve(dist, "core.cjs")).createGoogle).toBe(
      "function",
    );
  });

  it("CJS entries share one copy of errors and internals", async () => {
    const core = require(resolve(dist, "core.cjs"));
    const gmail = require(resolve(dist, "gmail.cjs"));
    const testing = require(resolve(dist, "testing.cjs"));
    const google = core.createGoogle({
      store: new testing.InMemoryStore(),
      keyProvider: new testing.LocalKeyProvider(),
      callbackUrl: "https://app.example.com/cb",
    });
    const send = gmail.createGmail(google, {
      transport: new testing.CaptureTransport(),
    }).send;
    const err = await send({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(core.InvalidMessageError);
    expect(err).toBeInstanceOf(core.GoogleLibError);
  });

  it("ESM /core with CJS /gmail: send reaches validation (shared internals key)", async () => {
    const core = await load("core");
    const gmail = require(resolve(dist, "gmail.cjs"));
    const testing = await load("testing");
    const google = (core.createGoogle as (o: unknown) => unknown)({
      store: new (testing.InMemoryStore as new () => unknown)(),
      keyProvider: new (testing.LocalKeyProvider as new () => unknown)(),
      callbackUrl: "https://app.example.com/cb",
    });
    const send = gmail.createGmail(google, {
      transport: new (testing.CaptureTransport as new () => unknown)(),
    }).send;
    const err = await send({
      tenantId: "t",
      connectionId: "c",
      actorId: "a",
      to: ["a@b.co"],
      subject: "s",
    }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TypeError);
    // instanceof is unreliable across ESM/CJS copies; match on code.
    expect(err).toMatchObject({ code: "invalid_message", field: "html" });
  });

  it("package.json maps every subpath with its own CJS types", () => {
    const pkg = require("../../package.json");
    expect(Object.keys(pkg.exports).sort()).toEqual([
      "./core",
      "./gmail",
      "./postgres",
      "./testing",
    ]);
    for (const entry of ["core", "gmail", "postgres", "testing"]) {
      expect(pkg.exports[`./${entry}`]).toEqual({
        import: {
          types: `./dist/${entry}.d.ts`,
          default: `./dist/${entry}.js`,
        },
        require: {
          types: `./dist/${entry}.d.cts`,
          default: `./dist/${entry}.cjs`,
        },
      });
    }
  });
});
