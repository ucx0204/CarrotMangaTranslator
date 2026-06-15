import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSimplePageRuntime } from "../src/main/simplePageRuntime";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeRuntimeStub(label: string): string {
  const runtimeDir = mkdtempSync(join(tmpdir(), "mgt-simple-runtime-"));
  tempDirs.push(runtimeDir);
  writeFileSync(
    join(runtimeDir, "simple-page-translate.cjs"),
    `
module.exports = {
  label: ${JSON.stringify(label)},
  startServer: async () => ({ baseUrl: "http://127.0.0.1", child: null, startedByScript: false }),
  stopServer: async () => {},
  isModelCached: () => true,
  testModelReply: async () => ({ outputText: ${JSON.stringify(label)}, launchTarget: { launchMode: "unknown" } })
};
`,
    "utf8",
  );
  return runtimeDir;
}

function writeRuntimeModule(source: string): string {
  const runtimeDir = mkdtempSync(join(tmpdir(), "mgt-simple-runtime-"));
  tempDirs.push(runtimeDir);
  writeFileSync(join(runtimeDir, "simple-page-translate.cjs"), source, "utf8");
  return runtimeDir;
}

describe("simple page runtime loader", () => {
  it("keeps simple-page-translate exports limited to the public runtime API", () => {
    const runtime =
      require("../src/main/runtime/simple-page-translate.cjs") as Record<
        string,
        unknown
      >;

    expect(Object.keys(runtime).sort()).toEqual([
      "collectOcrBboxHints",
      "collectOcrBboxHintsBatch",
      "convertImageToPngBufferWithFfmpeg",
      "ensurePaddleOcrRuntime",
      "isModelCached",
      "requestTranslation",
      "saveArtifacts",
      "startServer",
      "stopServer",
      "testModelReply",
    ]);
  });

  it("caches runtime modules by runtimeDir instead of globally", () => {
    const firstDir = writeRuntimeStub("first");
    const secondDir = writeRuntimeStub("second");

    const firstRuntime = loadSimplePageRuntime(firstDir) as ReturnType<
      typeof loadSimplePageRuntime
    > & { label: string };
    const secondRuntime = loadSimplePageRuntime(secondDir) as ReturnType<
      typeof loadSimplePageRuntime
    > & { label: string };

    expect(firstRuntime.label).toBe("first");
    expect(secondRuntime.label).toBe("second");
    expect(loadSimplePageRuntime(firstDir)).toBe(firstRuntime);
    expect(loadSimplePageRuntime(secondDir)).toBe(secondRuntime);
  });

  it("throws a clear error when a required runtime export is missing", () => {
    const runtimeDir = writeRuntimeModule(`
module.exports = {
  startServer: async () => ({ baseUrl: "http://127.0.0.1", child: null, startedByScript: false }),
  stopServer: async () => {},
  isModelCached: () => true
};
`);

    expect(() => loadSimplePageRuntime(runtimeDir)).toThrow(
      /simple-page-translate\.cjs.*testModelReply/,
    );
  });
});
