import type { EncryptedValue } from "../core/crypto/envelope.js";
import type { CredentialStore } from "../core/store.js";
import type {
  ConnectionRecord,
  EncryptedValueRef,
  OAuthClientRecord,
  OAuthStateRecord,
} from "../core/types.js";

/**
 * Minimal structural test API, injected by the caller (e.g. vitest's
 * `describe`, `it`, `expect`, `beforeEach`) so this library file never imports
 * a test runner at runtime.
 */
export type ContractTestApi = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect: (actual: any) => any;
  beforeEach: (fn: () => Promise<void> | void) => void;
};

const ev = (ct: string): EncryptedValue => ({
  v: 1,
  kid: "static:test",
  wdek: "AA",
  iv: "AA",
  ct,
  tag: "AA",
});

const T0 = new Date("2026-01-01T00:00:00.000Z");

const client = (
  tenantId: string,
  ct = `secret-${tenantId}`,
): OAuthClientRecord => ({
  tenantId,
  clientId: `${tenantId}.apps.googleusercontent.com`,
  clientSecret: ev(ct),
  secretHint: "…abcd",
  hostedDomain: null,
  createdBy: "admin",
  createdAt: T0,
  updatedBy: "admin",
  updatedAt: T0,
});

const conn = (
  id: string,
  tenantId: string,
  googleSub: string,
  over: Partial<ConnectionRecord> = {},
): ConnectionRecord => ({
  id,
  tenantId,
  googleSub,
  email: `${googleSub}@example.com`,
  displayName: null,
  scopes: ["openid", "email"],
  refreshToken: ev(`rt-${id}`),
  status: "active",
  statusReason: null,
  connectedBy: "admin",
  connectedAt: T0,
  updatedAt: T0,
  lastUsedAt: null,
  ...over,
});

const hashBytes = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const state = (
  n: number,
  tenantId: string,
  expiresAt: Date,
): OAuthStateRecord => ({
  stateHash: hashBytes(n),
  tenantId,
  actorId: "admin",
  intendedEmail: null,
  connectionId: null,
  scopes: ["openid", "email"],
  codeVerifier: ev(`cv-${n}`),
  expiresAt,
});

export function runStoreContractTests(
  name: string,
  makeStore: () => Promise<CredentialStore>,
  api: ContractTestApi,
): void {
  const { describe, it, expect, beforeEach } = api;

  describe(`CredentialStore contract: ${name}`, () => {
    let store: CredentialStore;
    beforeEach(async () => {
      store = await makeStore();
    });

    const seedClients = async () => {
      await store.upsertOAuthClient(client("t1"), { revokeConnections: false });
      await store.upsertOAuthClient(client("t2"), { revokeConnections: false });
    };

    it("getOAuthClient returns null for unknown tenant and a full record after upsert", async () => {
      expect(await store.getOAuthClient("nope")).toBeNull();
      const rec = client("t1");
      await store.upsertOAuthClient(rec, { revokeConnections: false });
      const got = await store.getOAuthClient("t1");
      expect(got).toEqual(rec);
      expect(got!.createdAt).toBeInstanceOf(Date);
      expect(got!.updatedAt).toBeInstanceOf(Date);
      expect(got!.createdAt.getTime()).toBe(T0.getTime());
    });

    it("isolates tenants on getConnection", async () => {
      await seedClients();
      await store.upsertConnection(conn("c1", "t1", "sub1"));
      expect(await store.getConnection("t2", "c1")).toBeNull();
      expect((await store.getConnection("t1", "c1"))!.id).toBe("c1");
    });

    it("listConnections excludes other tenants", async () => {
      await seedClients();
      await store.upsertConnection(conn("c1", "t1", "sub1"));
      await store.upsertConnection(conn("c2", "t2", "sub2"));
      const list = await store.listConnections("t1");
      expect(list.map((c) => c.id)).toEqual(["c1"]);
    });

    it("findConnectionBySub is tenant-scoped", async () => {
      await seedClients();
      await store.upsertConnection(conn("c1", "t1", "sub1"));
      expect((await store.findConnectionBySub("t1", "sub1"))!.id).toBe("c1");
      expect(await store.findConnectionBySub("t2", "sub1")).toBeNull();
    });

    it("upsertConnection with same (tenant, sub) and same id updates in place", async () => {
      await seedClients();
      await store.upsertConnection(conn("c1", "t1", "sub1"));
      await store.upsertConnection(
        conn("c1", "t1", "sub1", { email: "new@example.com" }),
      );
      const list = await store.listConnections("t1");
      expect(list).toHaveLength(1);
      expect(list[0]!.email).toBe("new@example.com");
    });

    it("upsertConnection with a different id but same (tenant, sub) rejects", async () => {
      await seedClients();
      await store.upsertConnection(conn("c1", "t1", "sub1"));
      await expect(
        store.upsertConnection(conn("c2", "t1", "sub1")),
      ).rejects.toThrow();
      expect(await store.listConnections("t1")).toHaveLength(1);
    });

    it("upsertOAuthClient with revokeConnections revokes only that tenant", async () => {
      await seedClients();
      await store.upsertConnection(conn("c1", "t1", "sub1"));
      await store.upsertConnection(conn("c2", "t1", "sub2"));
      await store.upsertConnection(conn("c3", "t2", "sub3"));
      await store.upsertOAuthClient(client("t1", "rotated"), {
        revokeConnections: true,
      });
      for (const c of await store.listConnections("t1")) {
        expect(c.status).toBe("revoked");
        expect(c.statusReason).toBe("client_changed");
      }
      const other = await store.getConnection("t2", "c3");
      expect(other!.status).toBe("active");
      expect(other!.statusReason).toBeNull();
    });

    it("upsertOAuthClient without revokeConnections leaves connections alone", async () => {
      await seedClients();
      await store.upsertConnection(conn("c1", "t1", "sub1"));
      await store.upsertOAuthClient(client("t1", "rotated"), {
        revokeConnections: false,
      });
      expect((await store.getConnection("t1", "c1"))!.status).toBe("active");
    });

    it("consumeOAuthState returns the record once, then null", async () => {
      const rec = state(1, "t1", new Date(T0.getTime() + 600_000));
      await store.insertOAuthState(rec);
      const first = await store.consumeOAuthState(hex(rec.stateHash), T0);
      expect(first).not.toBeNull();
      expect(first!.stateHash).toBeInstanceOf(Uint8Array);
      expect(Array.from(first!.stateHash)).toEqual(Array.from(rec.stateHash));
      expect(first!.expiresAt).toBeInstanceOf(Date);
      expect(first!.tenantId).toBe("t1");
      expect(await store.consumeOAuthState(hex(rec.stateHash), T0)).toBeNull();
    });

    it("concurrent consumeOAuthState yields exactly one winner", async () => {
      const rec = state(2, "t1", new Date(T0.getTime() + 600_000));
      await store.insertOAuthState(rec);
      const results = await Promise.all([
        store.consumeOAuthState(hex(rec.stateHash), T0),
        store.consumeOAuthState(hex(rec.stateHash), T0),
        store.consumeOAuthState(hex(rec.stateHash), T0),
      ]);
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it("consumeOAuthState returns null when expired", async () => {
      const rec = state(3, "t1", new Date(T0.getTime() + 1000));
      await store.insertOAuthState(rec);
      const later = new Date(T0.getTime() + 2000);
      expect(
        await store.consumeOAuthState(hex(rec.stateHash), later),
      ).toBeNull();
    });

    it("deleteExpiredOAuthStates returns the count deleted", async () => {
      await store.insertOAuthState(
        state(4, "t1", new Date(T0.getTime() + 1000)),
      );
      await store.insertOAuthState(
        state(5, "t2", new Date(T0.getTime() + 2000)),
      );
      await store.insertOAuthState(
        state(6, "t1", new Date(T0.getTime() + 900_000)),
      );
      const n = await store.deleteExpiredOAuthStates(
        new Date(T0.getTime() + 5000),
      );
      expect(n).toBe(2);
      expect(
        await store.deleteExpiredOAuthStates(new Date(T0.getTime() + 5000)),
      ).toBe(0);
    });

    it("iterateEncryptedValues yields every encrypted field across tenants; replaceEncryptedValue persists", async () => {
      await seedClients();
      await store.upsertConnection(conn("c1", "t1", "sub1"));
      await store.upsertConnection(conn("c2", "t2", "sub2"));
      await store.upsertConnection(
        conn("c3", "t2", "sub3", { refreshToken: null, status: "revoked" }),
      );
      const st = state(7, "t1", new Date(T0.getTime() + 600_000));
      await store.insertOAuthState(st);

      const refs: EncryptedValueRef[] = [];
      for await (const r of store.iterateEncryptedValues(2)) refs.push(r);

      const key = (r: EncryptedValueRef) =>
        `${r.tenantId}|${r.record}|${r.recordId}|${r.field}`;
      expect(refs.map(key).sort()).toEqual(
        [
          "t1|oauth_client|t1|client_secret",
          "t2|oauth_client|t2|client_secret",
          "t1|connection|c1|refresh_token",
          "t2|connection|c2|refresh_token",
          `t1|oauth_state|${hex(st.stateHash)}|code_verifier`,
        ].sort(),
      );

      for (const r of refs) {
        await store.replaceEncryptedValue(
          r,
          ev(`new-${r.record}-${r.recordId}`),
        );
      }
      expect((await store.getOAuthClient("t1"))!.clientSecret.ct).toBe(
        "new-oauth_client-t1",
      );
      expect((await store.getOAuthClient("t2"))!.clientSecret.ct).toBe(
        "new-oauth_client-t2",
      );
      expect((await store.getConnection("t1", "c1"))!.refreshToken!.ct).toBe(
        "new-connection-c1",
      );
      expect((await store.getConnection("t2", "c2"))!.refreshToken!.ct).toBe(
        "new-connection-c2",
      );
      expect((await store.getConnection("t2", "c3"))!.refreshToken).toBeNull();
      const consumed = await store.consumeOAuthState(hex(st.stateHash), T0);
      expect(consumed!.codeVerifier.ct).toBe(
        `new-oauth_state-${hex(st.stateHash)}`,
      );
    });

    it("touchConnection sets lastUsedAt", async () => {
      await seedClients();
      await store.upsertConnection(conn("c1", "t1", "sub1"));
      const at = new Date("2026-02-02T10:00:00.000Z");
      await store.touchConnection("t1", "c1", at);
      const got = await store.getConnection("t1", "c1");
      expect(got!.lastUsedAt).toBeInstanceOf(Date);
      expect(got!.lastUsedAt!.getTime()).toBe(at.getTime());
    });

    it("updateConnectionStatus sets status and reason (tenant-scoped)", async () => {
      await seedClients();
      await store.upsertConnection(conn("c1", "t1", "sub1"));
      await store.updateConnectionStatus("t2", "c1", "error", "wrong tenant");
      expect((await store.getConnection("t1", "c1"))!.status).toBe("active");
      await store.updateConnectionStatus("t1", "c1", "error", "invalid_grant");
      const got = await store.getConnection("t1", "c1");
      expect(got!.status).toBe("error");
      expect(got!.statusReason).toBe("invalid_grant");
    });
  });
}
