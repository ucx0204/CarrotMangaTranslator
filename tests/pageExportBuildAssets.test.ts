import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "vite";
import {
  PAGE_EXPORT_RUNTIME_FILE,
  PAGE_EXPORT_STYLES_FILE,
} from "../src/shared/pageExportContracts";

describe("page export browser assets", () => {
  it("builds fixed, self-contained runtime and stylesheet assets", async () => {
    const result = await build({
      configFile: resolve("vite.page-export.config.ts"),
      logLevel: "silent",
      build: {
        emptyOutDir: false,
        write: false,
      },
    });
    if ("on" in result) {
      throw new Error("Page export build unexpectedly entered watch mode.");
    }
    const outputs = Array.isArray(result)
      ? result.flatMap((entry) => entry.output)
      : result.output;

    expect(outputs.map((output) => output.fileName).sort()).toEqual(
      [
        PAGE_EXPORT_RUNTIME_FILE,
        `${PAGE_EXPORT_RUNTIME_FILE}.map`,
        PAGE_EXPORT_STYLES_FILE,
      ].sort(),
    );

    const runtime = outputs.find(
      (output) =>
        output.type === "chunk" && output.fileName === PAGE_EXPORT_RUNTIME_FILE,
    );
    const stylesheet = outputs.find(
      (output) =>
        output.type === "asset" && output.fileName === PAGE_EXPORT_STYLES_FILE,
    );
    expect(runtime?.type).toBe("chunk");
    expect(runtime?.type === "chunk" ? runtime.code : "").toContain(
      "page-export-data",
    );
    expect(runtime?.type === "chunk" ? runtime.code : "").not.toContain(
      "EXPORT_BLOCKS",
    );
    expect(runtime?.type === "chunk" ? runtime.code : "").not.toContain(
      "renderExportBlocks",
    );
    expect(runtime?.type === "chunk" ? runtime.code : "").not.toContain(
      "process.env.NODE_ENV",
    );
    expect(runtime?.type === "chunk" ? runtime.code : "").toContain(
      "translate3d(",
    );
    const css = stylesheet?.type === "asset" ? String(stylesheet.source) : "";
    expect(css).toContain(".page-export-stage .page-artwork");
    expect(css).toMatch(/html,\s*body\s*\{[^}]*overflow:\s*visible/);
    expect(css).toMatch(/html,\s*body\s*\{[^}]*width:\s*max-content/);
    expect(css).toContain(".overlay-transform-content");
    expect(css).toMatch(/transform-style:\s*preserve-3d/);
    expect(css).not.toContain("@font-face");
    expect(css).not.toContain(".app-shell");
  });
});
