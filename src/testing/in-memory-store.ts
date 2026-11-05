import type { EncryptedValue } from "../core/crypto/envelope.js";
import type { CredentialStore } from "../core/store.js";
import type {
  ConnectionRecord,
  ConnectionStatus,
  EncryptedValueRef,
  OAuthClientRecord,
  OAuthStateRecord,
} from "../core/types.js";

const clone = <T>(v: T): T => structuredClone(v);

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Re-materialise as a plain Uint8Array (structuredClone can yield a Buffer subclass-free copy, but be explicit). */
const toBytes = (b: Uint8Array): Uint8Array => new Uint8Array(b);

export class InMemoryStore implements CredentialStore {
  private clients = new Map<string, OAuthClientRecord>();
  private connections = new Map<string, ConnectionRecord>(); // by connection id
  private states = new Map<string, OAuthStateRecord>(); // by lowercase hex hash

  async getOAuthClient(tenantId: string): Promise<OAuthClientRecord | null> {
    const r = this.clients.get(tenantId);
    return r ? clone(r) : null;
  }

  async upsertOAuthClient(
    rec: OAuthClientRecord,
    opts: { revokeConnections: boolean },
  ): Promise<void> {
    this.clients.set(rec.tenantId, clone(rec));
    if (opts.revokeConnections) {
      for (const c of this.connections.values()) {
        if (c.tenantId === rec.tenantId) {
          c.status = "revoked";
          c.statusReason = "client_changed";
        }
      }
    }
  }

  async getConnection(
    tenantId: string,
    connectionId: string,
  ): Promise<ConnectionRecord | null> {
    const c = this.connections.get(connectionId);
    return c && c.tenantId === tenantId ? clone(c) : null;
  }

  async findConnectionBySub(
    tenantId: string,
    googleSub: string,
  ): Promise<ConnectionRecord | null> {
    for (const c of this.connections.values()) {
      if (c.tenantId === tenantId && c.googleSub === googleSub) return clone(c);
    }
    return null;
  }

  async listConnections(tenantId: string): Promise<ConnectionRecord[]> {
    return [...this.connections.values()]
      .filter((c) => c.tenantId === tenantId)
      .map(clone);
  }

  async upsertConnection(rec: ConnectionRecord): Promise<void> {
    for (const c of this.connections.values()) {
      if (
        c.id !== rec.id &&
        c.tenantId === rec.tenantId &&
        c.googleSub === rec.googleSub
      ) {
        throw new Error(
          "unique constraint violation: (tenantId, googleSub) already exists",
        );
      }
    }
    const existing = this.connections.get(rec.id);
    if (existing && existing.tenantId !== rec.tenantId) {
      throw new Error("connection id belongs to a different tenant");
    }
    this.connections.set(rec.id, clone(rec));
  }

  async updateConnectionStatus(
    tenantId: string,
    connectionId: string,
    status: ConnectionStatus,
    reason: string,
  ): Promise<void> {
    const c = this.connections.get(connectionId);
    if (c && c.tenantId === tenantId) {
      c.status = status;
      c.statusReason = reason;
    }
  }

  async touchConnection(
    tenantId: string,
    connectionId: string,
    at: Date,
  ): Promise<void> {
    const c = this.connections.get(connectionId);
    if (c && c.tenantId === tenantId) c.lastUsedAt = new Date(at.getTime());
  }

  async insertOAuthState(rec: OAuthStateRecord): Promise<void> {
    const copy = clone(rec);
    copy.stateHash = toBytes(copy.stateHash);
    this.states.set(toHex(copy.stateHash), copy);
  }

  async consumeOAuthState(
    stateHash: string,
    now: Date,
  ): Promise<OAuthStateRecord | null> {
    // No await between check and delete: atomic under Promise.all.
    const key = stateHash.toLowerCase();
    const s = this.states.get(key);
    if (!s || s.expiresAt.getTime() <= now.getTime()) return null;
    this.states.delete(key);
    const out = clone(s);
    out.stateHash = toBytes(out.stateHash);
    return out;
  }

  async deleteExpiredOAuthStates(now: Date): Promise<number> {
    let n = 0;
    for (const [k, s] of this.states) {
      if (s.expiresAt.getTime() <= now.getTime()) {
        this.states.delete(k);
        n++;
      }
    }
    return n;
  }

  async *iterateEncryptedValues(
    _batchSize: number,
  ): AsyncIterable<EncryptedValueRef> {
    const refs: EncryptedValueRef[] = [];
    for (const c of this.clients.values()) {
      refs.push({
        tenantId: c.tenantId,
        record: "oauth_client",
        recordId: c.tenantId,
        field: "client_secret",
        value: clone(c.clientSecret),
      });
    }
    for (const c of this.connections.values()) {
      if (c.refreshToken) {
        refs.push({
          tenantId: c.tenantId,
          record: "connection",
          recordId: c.id,
          field: "refresh_token",
          value: clone(c.refreshToken),
        });
      }
    }
    for (const [hex, s] of this.states) {
      refs.push({
        tenantId: s.tenantId,
        record: "oauth_state",
        recordId: hex,
        field: "code_verifier",
        value: clone(s.codeVerifier),
      });
    }
    for (const r of refs) yield r;
  }

  async replaceEncryptedValue(
    ref: EncryptedValueRef,
    value: EncryptedValue,
  ): Promise<boolean> {
    const v = clone(value);
    const same = (a: EncryptedValue | null | undefined): boolean =>
      a != null && JSON.stringify(a) === JSON.stringify(ref.value);
    if (ref.record === "oauth_client" && ref.field === "client_secret") {
      const c = this.clients.get(ref.recordId);
      if (c && c.tenantId === ref.tenantId && same(c.clientSecret)) {
        c.clientSecret = v;
        return true;
      }
      return false;
    } else if (ref.record === "connection" && ref.field === "refresh_token") {
      const c = this.connections.get(ref.recordId);
      if (c && c.tenantId === ref.tenantId && same(c.refreshToken)) {
        c.refreshToken = v;
        return true;
      }
      return false;
    } else if (ref.record === "oauth_state" && ref.field === "code_verifier") {
      const s = this.states.get(ref.recordId.toLowerCase());
      if (s && s.tenantId === ref.tenantId && same(s.codeVerifier)) {
        s.codeVerifier = v;
        return true;
      }
      return false;
    }
    throw new Error(`unknown encrypted field ${ref.record}/${ref.field}`);
  }
}
