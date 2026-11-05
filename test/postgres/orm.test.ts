import { describe, expect, it, vi } from "vitest";
import { InvalidConfigError } from "../../src/core/errors.js";
import {
  fromPrisma,
  fromTypeOrm,
  type TypeOrmQueryRunnerLike,
} from "../../src/postgres/index.js";

const SQL = "select * from t where secret = $1";
const PARAMS = ["ciphertext-SECRET", 7];

function runner(result: unknown | (() => Promise<unknown>)) {
  const r = {
    query: vi.fn(async () =>
      typeof result === "function"
        ? (result as () => Promise<unknown>)()
        : result,
    ),
    release: vi.fn(async () => {}),
  };
  return r satisfies TypeOrmQueryRunnerLike;
}

describe("fromTypeOrm", () => {
  it("asks for a structured result and maps records to rows", async () => {
    const r = runner({ records: [{ a: 1 }], raw: [[{ a: 1 }], 1] });
    const out = await fromTypeOrm(r)(SQL, PARAMS);
    expect(r.query).toHaveBeenCalledWith(SQL, PARAMS, true);
    expect(out).toEqual({ rows: [{ a: 1 }] });
  });

  it("creates and releases a runner per call when given a DataSource", async () => {
    const runners: ReturnType<typeof runner>[] = [];
    const ds = {
      createQueryRunner: vi.fn(() => {
        const r = runner({ records: [] });
        runners.push(r);
        return r;
      }),
    };
    const q = fromTypeOrm(ds);
    await q(SQL, PARAMS);
    await q(SQL, PARAMS);
    expect(ds.createQueryRunner).toHaveBeenCalledTimes(2);
    for (const r of runners) {
      expect(r.query).toHaveBeenCalledWith(SQL, PARAMS, true);
      expect(r.release).toHaveBeenCalledTimes(1);
    }
  });

  it("releases a runner it created even when the query throws", async () => {
    const boom = new Error("db down");
    const r = runner(() => Promise.reject(boom));
    const q = fromTypeOrm({ createQueryRunner: () => r });
    await expect(q(SQL, PARAMS)).rejects.toBe(boom);
    expect(r.release).toHaveBeenCalledTimes(1);
  });

  it("releases a runner it created when records are missing", async () => {
    const r = runner([[], 0]);
    const q = fromTypeOrm({ createQueryRunner: () => r });
    await expect(q(SQL, PARAMS)).rejects.toThrow(InvalidConfigError);
    expect(r.release).toHaveBeenCalledTimes(1);
  });

  it("never releases a QueryRunner passed in", async () => {
    const r = runner({ records: [] });
    const q = fromTypeOrm(r);
    await q(SQL, PARAMS);
    await q(SQL, PARAMS);
    expect(r.query).toHaveBeenCalledTimes(2);
    expect(r.release).not.toHaveBeenCalled();
  });

  it("never releases a passed-in QueryRunner on throw either", async () => {
    const r = runner(() => Promise.reject(new Error("x")));
    await expect(fromTypeOrm(r)(SQL, PARAMS)).rejects.toThrow("x");
    expect(r.release).not.toHaveBeenCalled();
  });

  it("throws InvalidConfigError naming TypeORM >= 0.3 when records is missing", async () => {
    for (const result of [[[], 0], [{ a: 1 }], undefined, { raw: [] }]) {
      const err = await fromTypeOrm(runner(result))(SQL, PARAMS).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(InvalidConfigError);
      expect((err as Error).message).toMatch(/TypeORM >= 0\.3/);
      expect((err as Error).message).not.toContain("SECRET");
      expect((err as Error).message).not.toContain(SQL);
    }
  });

  it("propagates ORM errors unchanged", async () => {
    const boom = Object.assign(new Error("dup"), { code: "23505" });
    await expect(
      fromTypeOrm(runner(() => Promise.reject(boom)))(SQL, PARAMS),
    ).rejects.toBe(boom);
  });
});

describe("fromPrisma", () => {
  it("spreads params into $queryRawUnsafe and wraps the array as rows", async () => {
    const client = { $queryRawUnsafe: vi.fn(async () => [{ a: 1 }]) };
    const out = await fromPrisma(client)(SQL, PARAMS);
    expect(client.$queryRawUnsafe).toHaveBeenCalledWith(SQL, ...PARAMS);
    expect(out).toEqual({ rows: [{ a: 1 }] });
  });

  it("passes no extra arguments when there are no params", async () => {
    const client = { $queryRawUnsafe: vi.fn(async () => []) };
    expect(await fromPrisma(client)("select 1", [])).toEqual({ rows: [] });
    expect(client.$queryRawUnsafe).toHaveBeenCalledWith("select 1");
  });

  it("throws InvalidConfigError on a non-array result without SQL or params", async () => {
    for (const result of [1, null, undefined, { rows: [] }, "x"]) {
      const client = { $queryRawUnsafe: async () => result };
      const err = await fromPrisma(client)(SQL, PARAMS).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(InvalidConfigError);
      expect((err as Error).message).not.toContain("SECRET");
      expect((err as Error).message).not.toContain(SQL);
    }
  });

  it("propagates errors unchanged", async () => {
    const boom = Object.assign(new Error("raw query failed"), {
      code: "P2010",
    });
    const client = { $queryRawUnsafe: () => Promise.reject(boom) };
    await expect(fromPrisma(client)(SQL, PARAMS)).rejects.toBe(boom);
  });
});
