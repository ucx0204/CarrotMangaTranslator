import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/out/**", "**/.tmp/**"],
    testTimeout: 15000,
  },
});
