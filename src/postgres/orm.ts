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

const isDataSource = (
  s: TypeOrmDataSourceLike | TypeOrmQueryRunnerLike,
): s is TypeOrmDataSourceLike =>
  typeof (s as TypeOrmDataSourceLike).createQueryRunner === "function";

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
 * it. Given a QueryRunner (for example one pinned for row-level security),
 * it is used as is and never released: the caller owns its lifetime.
 */
export function fromTypeOrm(
  source: TypeOrmDataSourceLike | TypeOrmQueryRunnerLike,
): Query {
  if (isDataSource(source)) {
    return (async (sql: string, params: unknown[]) => {
      const runner = source.createQueryRunner();
      try {
        return { rows: structuredRows(await runner.query(sql, params, true)) };
      } finally {
        await runner.release();
      }
    }) as Query;
  }
  return (async (sql: string, params: unknown[]) => ({
    rows: structuredRows(await source.query(sql, params, true)),
  })) as Query;
}
