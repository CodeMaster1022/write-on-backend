import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup.ts"],
    // The first run downloads a MongoDB binary for the in-memory database.
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
