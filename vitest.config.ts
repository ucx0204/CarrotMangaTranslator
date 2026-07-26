import { defineConfig } from "vitest/config";

const enforceWindowsCoverageThresholds = process.platform === "win32";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      include: [
        "src/main/**/*.{ts,cjs}",
        "src/preload/**/*.ts",
        "src/renderer/src/**/*.{ts,tsx}",
        "src/shared/**/*.ts",
      ],
      exclude: [
        "**/*.d.ts",
        "src/renderer/src/global.d.ts",
        "src/renderer/src/main.tsx",
        // Boot-only IIFE behavior is exercised in a real Electron renderer by
        // qa:page-artwork-parity instead of a simulated Vitest environment.
        "src/renderer/src/pageExport/browserEntry.tsx",
      ],
      thresholds: {
        // The Windows job is the canonical global coverage gate because it
        // executes the Windows runtime/settings suites that are intentionally
        // skipped on macOS. macOS still collects coverage and enforces the
        // platform-neutral file thresholds below.
        ...(enforceWindowsCoverageThresholds
          ? {
              statements: 66,
              branches: 59,
              functions: 66,
              lines: 67,
            }
          : {}),
        "src/main/inpainting/jsonLinesWorkerClient.ts": {
          statements: 90,
          branches: 85,
          functions: 100,
          lines: 90,
        },
        "src/main/libraryStore/libraryPaths.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        "src/main/runtimeModuleLoader.ts": {
          statements: 91,
          branches: 100,
          functions: 83,
          lines: 91,
        },
        "src/renderer/src/pageExport/**/*.{ts,tsx}": {
          statements: 77,
          branches: 63,
          functions: 77,
          lines: 77,
        },
        "src/shared/shortcutSettings.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
    exclude: ["**/node_modules/**", "**/dist/**", "**/out/**", "**/.tmp/**"],
    maxWorkers: 4,
    testTimeout: 15000,
    setupFiles: ["./tests/setupI18n.ts"],
  },
});
