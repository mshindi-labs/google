import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { getMigrations } from "../../src/postgres/migrations.js";

/**
 * One in-memory PGlite served over the Postgres wire protocol, so real
 * `pg`-based clients (TypeORM, Prisma's adapter-pg) talk to it like a server.
 */
export async function startPgSocket(): Promise<{
  url: string;
  db: PGlite;
  stop: () => Promise<void>;
}> {
  const db = await PGlite.create();
  for (const m of getMigrations()) await db.exec(m.sql);
  const server = new PGLiteSocketServer({
    db,
    port: 0,
    host: "127.0.0.1",
    maxConnections: 20,
  });
  await server.start();
  const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?sslmode=disable`;
  return {
    url,
    db,
    stop: async () => {
      await server.stop();
      await db.close();
    },
  };
}

/** Empties the library's tables between contract tests. */
export const TRUNCATE_ALL = `truncate google_audit_events, google_oauth_states,
  google_connections, google_oauth_clients restart identity cascade`;
