import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, "src/preload/index.ts"),
      fileName: () => "index.js",
      formats: ["cjs"],
    },
    minify: false,
    outDir: "out/preload",
    rollupOptions: {
      external: ["electron"],
      output: {
        entryFileNames: "index.js",
      },
    },
    sourcemap: true,
    target: "es2022",
  },
});
