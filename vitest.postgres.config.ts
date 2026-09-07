import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.postgres.test.ts"],
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
