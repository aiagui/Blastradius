import { defineConfig } from "vitest/config";

// Tests that run the built CLI as a real process (needs `npm run build`).
export default defineConfig({
  test: {
    include: ["test-bin/**/*.test.ts"],
    environment: "node",
  },
});
