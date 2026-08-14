/* eslint-disable @typescript-eslint/no-require-imports -- Knip loads this CommonJS config directly */
const { resolve } = require("node:path");
const {
  buildScriptEntrypointInventory,
} = require("./scripts/script-entrypoint-inventory.cjs");

const repoRoot = resolve(__dirname);
const { entries, orphans } = buildScriptEntrypointInventory(repoRoot);
if (orphans.length > 0) {
  throw new Error(
    `Unowned root scripts must be removed or declared before Knip runs: ${orphans.join(", ")}`,
  );
}

module.exports = {
  entry: [
    "src/main/bootstrap.ts",
    "src/preload/index.ts",
    "src/renderer/src/main.tsx",
    "src/renderer/src/pageExport/browserEntry.tsx",
    "tests/pageArtworkPixelParityPanelEntry.tsx",
    "tests/fixtures/dataRootInstanceLockWorker.ts",
    "scripts/font-render-bank/electron-runner.cjs",
    "scripts/library-full-pipeline-qa/electron-runner.cjs",
    "scripts/library-full-pipeline-qa/font-inference-runtime-validator.cjs",
    "scripts/page-artwork-pixel-parity/electron-runner.cjs",
    "vite.renderer.config.ts",
    "vite.page-export.config.ts",
    "vitest.config.ts",
    "electron-builder.config.cjs",
    ...entries,
  ],
  project: [
    "src/**/*.{ts,tsx,cjs}",
    "tests/**/*.ts",
    "scripts/**/*.{cjs,mjs}",
    "vite.renderer.config.ts",
    "vite.page-export.config.ts",
    "vitest.config.ts",
    "electron-builder.config.cjs",
  ],
  ignore: [
    "src/main/runtime/paddleocr-vl-bboxes.py",
    "src/main/runtime/build-page-variant.ps1",
    "scripts/crop_image.ps1",
  ],
  ignoreDependencies: ["openai-oauth"],
};
