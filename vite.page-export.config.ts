import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import {
  PAGE_EXPORT_ASSET_DIRECTORY,
  PAGE_EXPORT_RUNTIME_FILE,
  PAGE_EXPORT_STYLES_FILE,
} from "./src/shared/pageExportContracts";

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    // The filenames are fixed and overwritten atomically. Avoid recursively
    // deleting this directory because a running dev window can still have the
    // previous source map open on Windows.
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, "src/renderer/src/pageExport/browserEntry.tsx"),
      formats: ["iife"],
      name: "MangaPageExport",
      fileName: () => PAGE_EXPORT_RUNTIME_FILE,
      cssFileName: "styles",
    },
    minify: false,
    outDir: `out/${PAGE_EXPORT_ASSET_DIRECTORY}`,
    rollupOptions: {
      output: {
        entryFileNames: PAGE_EXPORT_RUNTIME_FILE,
        assetFileNames: (assetInfo) =>
          assetInfo.names.some((name) => name.endsWith(".css"))
            ? PAGE_EXPORT_STYLES_FILE
            : "assets/[name]-[hash][extname]",
      },
    },
    sourcemap: true,
    target: "es2022",
  },
});
