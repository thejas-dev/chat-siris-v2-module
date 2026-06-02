import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      INTERNAL_HMAC_SECRET: "test-hmac-secret-for-integration",
    },
  },
});
