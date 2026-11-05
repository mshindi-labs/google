import { defineConfig } from "vitest/config";

// Runs against the built package: `npm run build && npm run test:package`.
export default defineConfig({
  test: {
    include: ["test/package/**/*.test.ts"],
  },
});
