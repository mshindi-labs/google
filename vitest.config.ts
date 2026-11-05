import { defineConfig } from "vitest/config";

// The real-ORM suites need Node >= 20 (prisma 7, typeorm 1, pglite-socket's CustomEvent).
const nodeMajor = Number(process.versions.node.split(".")[0]);
const ormSuites =
  nodeMajor < 20
    ? ["test/postgres/orm-typeorm.test.ts", "test/postgres/orm-prisma.test.ts"]
    : [];
if (ormSuites.length) {
  console.warn(
    `Node ${process.versions.node} < 20: skipping the real Prisma/TypeORM suites (${ormSuites.join(", ")})`,
  );
}

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/package/**", "node_modules/**", ...ormSuites],
  },
});
