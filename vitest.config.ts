import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/config/**/*.test.ts", "tests/setup/**/*.test.ts", "tests/lifecycle/**/*.test.ts", "tests/release/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.worktrees/**", "**/.git/**"],
  },
});
