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

/** Connection ids are UUIDs so the Postgres adapter can use a uuid column. */
const C = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

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
      await store.upsertConnection(conn(C(1), "t1", "sub1"));
      expect(await store.getConnection("t2", C(1))).toBeNull();
      expect((await store.getConnection("t1", C(1)))!.id).toBe(C(1));
    });

    it("listConnections excludes other tenants", async () => {
      await seedClients();
      await store.upsertConnection(conn(C(1), "t1", "sub1"));
      await store.upsertConnection(conn(C(2), "t2", "sub2"));
      const list = await store.listConnections("t1");
      expect(list.map((c) => c.id)).toEqual([C(1)]);
    });

    it("findConnectionBySub is tenant-scoped", async () => {
      await seedClients();
      await store.upsertConnection(conn(C(1), "t1", "sub1"));
      expect((await store.findConnectionBySub("t1", "sub1"))!.id).toBe(C(1));
      expect(await store.findConnectionBySub("t2", "sub1")).toBeNull();
    });

    it("upsertConnection with same (tenant, sub) and same id updates in place", async () => {
      await seedClients();
      await store.upsertConnection(conn(C(1), "t1", "sub1"));
      await store.upsertConnection(
        conn(C(1), "t1", "sub1", { email: "new@example.com" }),
      );
      const list = await store.listConnections("t1");
      expect(list).toHaveLength(1);
      expect(list[0]!.email).toBe("new@example.com");
    });

    it("upsertConnection with a different id but same (tenant, sub) rejects", async () => {
      await seedClients();
      await store.upsertConnection(conn(C(1), "t1", "sub1"));
      await expect(
        store.upsertConnection(conn(C(2), "t1", "sub1")),
      ).rejects.toThrow();
      expect(await store.listConnections("t1")).toHaveLength(1);
    });

    it("upsertOAuthClient with revokeConnections revokes only that tenant", async () => {
      await seedClients();
      await store.upsertConnection(conn(C(1), "t1", "sub1"));
      await store.upsertConnection(conn(C(2), "t1", "sub2"));
      await store.upsertConnection(conn(C(3), "t2", "sub3"));
      await store.upsertOAuthClient(client("t1", "rotated"), {
        revokeConnections: true,
      });
      for (const c of await store.listConnections("t1")) {
        expect(c.status).toBe("revoked");
        expect(c.statusReason).toBe("client_changed");
      }
      const other = await store.getConnection("t2", C(3));
      expect(other!.status).toBe("active");
      expect(other!.statusReason).toBeNull();
    });

    it("upsertOAuthClient without revokeConnections leaves connections alone", async () => {
      await seedClients();
      await store.upsertConnection(conn(C(1), "t1", "sub1"));
      await store.upsertOAuthClient(client("t1", "rotated"), {
        revokeConnections: false,
      });
      expect((await store.getConnection("t1", C(1)))!.status).toBe("active");
    });

    it("upsertOAuthClient update path replaces the record and leaves other tenants alone", async () => {
      await seedClients();
      await store.upsertOAuthClient(client("t1", "rotated"), {
        revokeConnections: false,
      });
      expect((await store.getOAuthClient("t1"))!.clientSecret.ct).toBe(
        "rotated",
      );
      expect(await store.getOAuthClient("t2")).toEqual(client("t2"));
    });

    it("getOAuthClient returns each tenant its own record", async () => {
      await seedClients();
      expect((await store.getOAuthClient("t1"))!.clientSecret.ct).toBe(
        "secret-t1",
      );
      expect((await store.getOAuthClient("t2"))!.clientSecret.ct).toBe(
        "secret-t2",
      );
      expect((await store.getOAuthClient("t1"))!.tenantId).toBe("t1");
    });

    it("upsertConnection allows the same googleSub in different tenants", async () => {
      await seedClients();
      await store.upsertConnection(conn(C(1), "t1", "sub1"));
      await store.upsertConnection(conn(C(2), "t2", "sub1"));
      expect((await store.getConnection("t1", C(1)))!.id).toBe(C(1));
      expect((await store.getConnection("t2", C(2)))!.id).toBe(C(2));
    });

    it("upsertConnection cannot take over another tenant's connection id", async () => {
      await seedClients();
      const original = conn(C(1), "t1", "sub1");
      await store.upsertConnection(original);
      await expect(
        store.upsertConnection(
          conn(C(1), "t2", "subX", { email: "evil@example.com" }),
        ),
      ).rejects.toThrow();
      expect(await store.getConnection("t1", C(1))).toEqual(original);
      expect(await store.getConnection("t2", C(1))).toBeNull();
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
      await store.upsertConnection(conn(C(1), "t1", "sub1"));
      await store.upsertConnection(conn(C(2), "t2", "sub2"));
      await store.upsertConnection(
        conn(C(3), "t2", "sub3", { refreshToken: null, status: "revoked" }),
      );
      const st = state(7, "t1", new Date(T0.getTime() + 600_000));
      await store.insertOAuthState(st);

      const refs: EncryptedValueRef[] = [];
      for await (const r of store.iterateEncryptedValues(2)) refs.push(r);

      const key = (r: EncryptedValueRef) =>
        `${r.tenantId}|${r.record}|${r.recordId}|${r.field}`;
      const expectedCt: Record<string, string> = {
        "t1|oauth_client|t1|client_secret": "secret-t1",
        "t2|oauth_client|t2|client_secret": "secret-t2",
        [`t1|connection|${C(1)}|refresh_token`]: `rt-${C(1)}`,
        [`t2|connection|${C(2)}|refresh_token`]: `rt-${C(2)}`,
        [`t1|oauth_state|${hex(st.stateHash)}|code_verifier`]: "cv-7",
      };
      for (const r of refs) expect(r.value.ct).toBe(expectedCt[key(r)]);
      expect(refs.map(key).sort()).toEqual(
        [
          "t1|oauth_client|t1|client_secret",
          "t2|oauth_client|t2|client_secret",
          `t1|connection|${C(1)}|refresh_token`,
          `t2|connection|${C(2)}|refresh_token`,
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
      expect((await store.getConnection("t1", C(1)))!.refreshToken!.ct).toBe(
        `new-connection-${C(1)}`,
      );
      expect((await store.getConnection("t2", C(2)))!.refreshToken!.ct).toBe(
        `new-connection-${C(2)}`,
      );
      expect((await store.getConnection("t2", C(3)))!.refreshToken).toBeNull();
      const consumed = await store.consumeOAuthState(hex(st.stateHash), T0);
      expect(consumed!.codeVerifier.ct).toBe(
        `new-oauth_state-${hex(st.stateHash)}`,
      );
    });

    it("replaceEncryptedValue ignores refs with the wrong tenantId", async () => {
      await seedClients();
      await store.upsertConnection(conn(C(1), "t1", "sub1"));
      const st = state(8, "t1", new Date(T0.getTime() + 600_000));
      await store.insertOAuthState(st);
      const base = { value: ev("x") };
      const bad: EncryptedValueRef[] = [
        {
          ...base,
          tenantId: "t2",
          record: "connection",
          recordId: C(1),
          field: "refresh_token",
        },
        {
          ...base,
          tenantId: "t2",
          record: "oauth_client",
          recordId: "t1",
          field: "client_secret",
        },
        {
          ...base,
          tenantId: "t2",
          record: "oauth_state",
          recordId: hex(st.stateHash),
          field: "code_verifier",
        },
      ];
      for (const ref of bad) {
        try {
          await store.replaceEncryptedValue(ref, ev("hijacked"));
        } catch {
          // rejecting is acceptable; mutating is not
        }
      }
      expect((await store.getConnection("t1", C(1)))!.refreshToken!.ct).toBe(
        `rt-${C(1)}`,
      );
      expect((await store.getOAuthClient("t1"))!.clientSecret.ct).toBe(
        "secret-t1",
      );
      const consumed = await store.consumeOAuthState(hex(st.stateHash), T0);
      expect(consumed!.codeVerifier.ct).toBe("cv-8");
    });

    it("replaceEncryptedValue during iteration visits every ref exactly once", async () => {
      await seedClients();
      for (let i = 0; i < 5; i++) {
        await store.upsertConnection(conn(C(i), "t1", `sub${i}`));
      }
      await store.insertOAuthState(
        state(9, "t2", new Date(T0.getTime() + 600_000)),
      );
      const visited: string[] = [];
      for await (const r of store.iterateEncryptedValues(2)) {
        visited.push(`${r.record}|${r.recordId}`);
        await store.replaceEncryptedValue(
          r,
          ev(`new-${r.record}-${r.recordId}`),
        );
      }
      expect(visited).toHaveLength(2 + 5 + 1);
      expect(new Set(visited).size).toBe(visited.length);
      for (let i = 0; i < 5; i++) {
        expect((await store.getConnection("t1", C(i)))!.refreshToken!.ct).toBe(
          `new-connection-${C(i)}`,
        );
      }
      expect((await store.getOAuthClient("t1"))!.clientSecret.ct).toBe(
        "new-oauth_client-t1",
      );
      expect((await store.getOAuthClient("t2"))!.clientSecret.ct).toBe(
        "new-oauth_client-t2",
      );
      const consumed = await store.consumeOAuthState(hex(hashBytes(9)), T0);
      expect(consumed!.codeVerifier.ct).toBe(
        `new-oauth_state-${hex(hashBytes(9))}`,
      );
    });

    it("touchConnection is tenant-scoped", async () => {
      await seedClients();
      await store.upsertConnection(conn(C(1), "t1", "sub1"));
      await store.touchConnection(
        "t2",
        C(1),
        new Date("2026-02-02T10:00:00.000Z"),
      );
      expect((await store.getConnection("t1", C(1)))!.lastUsedAt).toBeNull();
    });

    it("touchConnection sets lastUsedAt", async () => {
      await seedClients();
      await store.upsertConnection(conn(C(1), "t1", "sub1"));
      const at = new Date("2026-02-02T10:00:00.000Z");
      await store.touchConnection("t1", C(1), at);
      const got = await store.getConnection("t1", C(1));
      expect(got!.lastUsedAt).toBeInstanceOf(Date);
      expect(got!.lastUsedAt!.getTime()).toBe(at.getTime());
    });

    it("updateConnectionStatus sets status and reason (tenant-scoped)", async () => {
      await seedClients();
      await store.upsertConnection(conn(C(1), "t1", "sub1"));
      await store.updateConnectionStatus("t2", C(1), "error", "wrong tenant");
      expect((await store.getConnection("t1", C(1)))!.status).toBe("active");
      await store.updateConnectionStatus("t1", C(1), "error", "invalid_grant");
      const got = await store.getConnection("t1", C(1));
      expect(got!.status).toBe("error");
      expect(got!.statusReason).toBe("invalid_grant");
    });
  });
}
