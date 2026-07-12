import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/out/**", "**/.tmp/**"],
    maxWorkers: 4,
    testTimeout: 15000,
    setupFiles: ["./tests/setupI18n.ts"],
  },
});
