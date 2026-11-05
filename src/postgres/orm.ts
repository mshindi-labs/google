import { InvalidConfigError } from "../core/errors.js";
import type { Query } from "./store.js";

/**
 * The slice of a Prisma client (or interactive-transaction client `tx`) the
 * wrapper needs. Duck-typed: this library never imports Prisma.
 */
export type PrismaLike = {
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
};

/**
 * Adapts a Prisma client to the Postgres store's `query` option.
 *
 * `$queryRawUnsafe` with positional `$n` placeholders sends params separately
 * from the SQL (no interpolation), and on Postgres it returns `[]` for
 * statements without RETURNING, so every adapter statement can use it.
 */
export function fromPrisma(client: PrismaLike): Query {
  return (async (sql: string, params: unknown[]) => {
    const rows = await client.$queryRawUnsafe(sql, ...params);
    if (!Array.isArray(rows)) {
      throw new InvalidConfigError(
        "Prisma $queryRawUnsafe did not return an array of rows",
      );
    }
    return { rows };
  }) as Query;
}

/** The slice of a TypeORM QueryRunner the wrapper needs. */
export type TypeOrmQueryRunnerLike = {
  query(
    query: string,
    parameters?: unknown[],
    useStructuredResult?: boolean,
  ): Promise<unknown>;
  release(): Promise<void>;
};

/** The slice of a TypeORM DataSource the wrapper needs. */
export type TypeOrmDataSourceLike = {
  createQueryRunner(): TypeOrmQueryRunnerLike;
};

// A QueryRunner also exposes `release`; anything with `release` is treated as
// a caller-owned runner, even if it also has `createQueryRunner`.
const isDataSource = (
  s: TypeOrmDataSourceLike | TypeOrmQueryRunnerLike,
): s is TypeOrmDataSourceLike =>
  typeof (s as TypeOrmDataSourceLike).createQueryRunner === "function" &&
  typeof (s as TypeOrmQueryRunnerLike).release !== "function";

// TypeORM's QueryFailedError carries every bound parameter (encrypted
// envelopes, emails, Google subject ids). Drop them; keep the same object so
// `instanceof`, `code`, `constraint` and `message` still work.
const scrub = (err: unknown): unknown => {
  if (err !== null && typeof err === "object" && "parameters" in err) {
    try {
      (err as { parameters?: unknown }).parameters = undefined;
    } catch {
      // A frozen or getter-only error is rethrown as is.
    }
  }
  return err;
};

const run = async (
  runner: TypeOrmQueryRunnerLike,
  sql: string,
  params: unknown[],
): Promise<{ rows: unknown[] }> => {
  let result: unknown;
  try {
    result = await runner.query(sql, params, true);
  } catch (err) {
    throw scrub(err);
  }
  return { rows: structuredRows(result) };
};

const structuredRows = (result: unknown): unknown[] => {
  const records = (result as { records?: unknown } | null | undefined)?.records;
  if (!Array.isArray(records)) {
    throw new InvalidConfigError(
      "TypeORM QueryRunner did not return a structured result with records; TypeORM >= 0.3 is required",
    );
  }
  return records;
};

/**
 * Adapts a TypeORM DataSource or QueryRunner to the Postgres store's `query`
 * option.
 *
 * Always requests TypeORM's structured result (`query(sql, params, true)`).
 * The plain result of an UPDATE or DELETE on the Postgres driver is
 * `[rows, affectedCount]`, which would make `DELETE … RETURNING` (one-time
 * OAuth state consumption) and `UPDATE … RETURNING` (compare-and-swap key
 * rotation) look like they matched a row when they did not.
 *
 * Given a DataSource, a QueryRunner is created per call and released after
 * it. Given a QueryRunner (for example one pinned for row-level security, or
 * `manager.queryRunner` inside `dataSource.transaction`), it is used as is and
 * never released: the caller owns its lifetime. An object with a `release`
 * method counts as a QueryRunner even if it also has `createQueryRunner`.
 *
 * Errors are rethrown as the same object, with TypeORM's `parameters`
 * property cleared so bound values (ciphertext, emails) do not leak into logs.
 */
export function fromTypeOrm(
  source: TypeOrmDataSourceLike | TypeOrmQueryRunnerLike,
): Query {
  if (isDataSource(source)) {
    return (async (sql: string, params: unknown[]) => {
      const runner = source.createQueryRunner();
      let out: { rows: unknown[] };
      try {
        out = await run(runner, sql, params);
      } catch (err) {
        // A release failure must not hide the query error.
        await runner.release().catch(() => {});
        throw err;
      }
      await runner.release();
      return out;
    }) as Query;
  }
  return ((sql: string, params: unknown[]) =>
    run(source, sql, params)) as Query;
}
