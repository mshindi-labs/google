import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresStore,
  fromPrisma,
  type PrismaLike,
} from "../../src/postgres/index.js";
import { runStoreContractTests } from "../../src/testing/index.js";
import { startPgSocket, TRUNCATE_ALL } from "./pg-socket.js";

// Real Prisma Client (prisma-client generator + adapter-pg) against PGlite via
// pglite-socket. The schema is the one published in the ORM guide, so this
// suite also checks that the guide's models match the migration.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = resolve(root, "node_modules/.cache/google-orm-prisma");
const prismaCli = resolve(root, "node_modules/prisma/build/index.js");

const guideSchema = (): string => {
  const md = readFileSync(
    resolve(root, "docs/guides/orm-integration.md"),
    "utf8",
  );
  const block = md.match(/```prisma\n([\s\S]*?)```/);
  if (!block) throw new Error("no prisma block in orm-integration.md");
  return block[1]!.replace(/output\s*=\s*".*"/, 'output = "./generated"');
};

const prisma_ = (args: string[], url: string) =>
  promisify(execFile)(process.execPath, [prismaCli, ...args], {
    cwd: work,
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  });

type Client = PrismaLike & {
  $executeRawUnsafe(sql: string): Promise<number>;
  $disconnect(): Promise<void>;
};

let pg: Awaited<ReturnType<typeof startPgSocket>>;
let prisma: Client;

beforeAll(async () => {
  pg = await startPgSocket();
  mkdirSync(work, { recursive: true });
  writeFileSync(resolve(work, "schema.prisma"), guideSchema());
  writeFileSync(
    resolve(work, "prisma.config.ts"),
    `export default { schema: "schema.prisma", datasource: { url: process.env.DATABASE_URL } };\n`,
  );
  await prisma_(["generate"], pg.url);
  const { PrismaClient } = (await import(
    pathToFileURL(resolve(work, "generated/client.ts")).href
  )) as { PrismaClient: new (o: unknown) => Client };
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: pg.url }),
  });
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await pg?.stop();
});

runStoreContractTests(
  "PostgresStore via Prisma",
  async () => {
    await prisma.$executeRawUnsafe(TRUNCATE_ALL);
    return createPostgresStore({ query: fromPrisma(prisma) });
  },
  { describe, it, expect, beforeEach },
);

describe("Prisma integration", () => {
  it("returns [] for statements without RETURNING and native types", async () => {
    await prisma.$executeRawUnsafe(TRUNCATE_ALL);
    const q = fromPrisma(prisma);
    expect(
      await q("update google_oauth_clients set secret_hint = $1", ["x"]),
    ).toEqual({ rows: [] });
    const { rows } = await q<Record<string, unknown>>(
      `select decode($1, 'hex') as b, $2::text[] as arr, count(*)::int as n,
         count(*) as big, $3::timestamptz as ts, $4::jsonb as j, $5::bytea as u8`,
      [
        "0a0b",
        ["a", "b"],
        "2026-01-01T00:00:00.000Z",
        JSON.stringify({ k: [1] }),
        new Uint8Array([1, 2]),
      ],
    );
    expect(rows[0]).toEqual({
      b: new Uint8Array([10, 11]),
      arr: ["a", "b"],
      n: 1,
      big: 1n, // bigint columns come back as BigInt; the store casts counts to int
      ts: new Date("2026-01-01T00:00:00.000Z"),
      j: { k: [1] },
      u8: new Uint8Array([1, 2]),
    });
  });

  it("the guide's schema.prisma matches the migration exactly", async () => {
    const { stdout } = await prisma_(
      [
        "migrate",
        "diff",
        "--from-config-datasource",
        "--to-schema",
        "schema.prisma",
        "--script",
        "--exit-code",
      ],
      pg.url,
    );
    expect(stdout).toContain("This is an empty migration.");
  }, 60_000);
});
