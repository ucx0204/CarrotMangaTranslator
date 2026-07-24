import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type CachedBuildStep = {
  cacheFile: string;
  cacheKey: string;
  fingerprintSalt: string;
  getInputFiles: () => string[];
  getOutputFiles: () => string[];
  getRequiredOutputFiles: () => string[];
  root: string;
};

type CachedBuildPlan = {
  decision: "build" | "skip";
  inputFingerprint: string;
  reason: string;
};

type DevBuildCacheModule = {
  listTreeFiles: (
    directory: string,
    include?: (filePath: string) => boolean,
    allowMissing?: boolean,
  ) => string[];
  planCachedBuildStep: (step: CachedBuildStep) => CachedBuildPlan;
  runCachedBuildStep: (
    step: CachedBuildStep,
    build: () => void,
  ) => { status: "built" | "skipped"; reason: string };
};

const cache = require("../scripts/dev-build-cache.cjs") as DevBuildCacheModule;
const { cleanElectronTypeScriptOutDirs } =
  require("../scripts/compile-electron.cjs") as {
    cleanElectronTypeScriptOutDirs: (root?: string) => void;
  };
const temporaryRoots: string[] = [];
const temporaryPrefix = join(tmpdir(), "dev-build-cache-test-");

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    if (!root.startsWith(temporaryPrefix)) {
      throw new Error(`Refusing to clean unexpected test path: ${root}`);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = mkdtempSync(temporaryPrefix);
  temporaryRoots.push(root);
  const inputDir = join(root, "input");
  const outputDir = join(root, "output");
  const cacheFile = join(root, ".tmp", "step.json");
  mkdirSync(inputDir, { recursive: true });
  writeFileSync(join(inputDir, "a.txt"), "alpha", "utf8");

  const inputFiles = () => cache.listTreeFiles(inputDir);
  const requiredOutputs = () =>
    inputFiles().map((inputPath) => join(outputDir, basename(inputPath)));
  const step: CachedBuildStep = {
    root,
    cacheFile,
    cacheKey: "fixture",
    fingerprintSalt: "test-platform",
    getInputFiles: inputFiles,
    getOutputFiles: () => cache.listTreeFiles(outputDir, undefined, true),
    getRequiredOutputFiles: requiredOutputs,
  };

  function rebuild() {
    rmSync(outputDir, { recursive: true, force: true });
    mkdirSync(outputDir, { recursive: true });
    for (const inputPath of inputFiles()) {
      copyFileSync(inputPath, join(outputDir, basename(inputPath)));
    }
  }

  return { root, inputDir, outputDir, cacheFile, step, rebuild };
}

function createTypeScriptCleanupFixture() {
  const root = mkdtempSync(temporaryPrefix);
  temporaryRoots.push(root);
  const sourceDir = join(root, "src", "main");
  const mainOutDir = join(root, "out", "main");
  const sharedOutDir = join(root, "out", "shared");
  const preloadMarker = join(root, "out", "preload", "keep.js");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(join(root, "out", "preload"), { recursive: true });
  writeFileSync(join(sourceDir, "keep.ts"), "keep", "utf8");
  writeFileSync(join(sourceDir, "removed.ts"), "remove", "utf8");
  writeFileSync(preloadMarker, "preload", "utf8");

  const inputFiles = () => cache.listTreeFiles(sourceDir);
  const step: CachedBuildStep = {
    root,
    cacheFile: join(root, ".tmp", "typescript.json"),
    cacheKey: "typescript-cleanup",
    fingerprintSalt: "test-platform",
    getInputFiles: inputFiles,
    getOutputFiles: () => [
      ...cache.listTreeFiles(mainOutDir, undefined, true),
      ...cache.listTreeFiles(sharedOutDir, undefined, true),
    ],
    getRequiredOutputFiles: () =>
      inputFiles().map((sourcePath) =>
        join(mainOutDir, basename(sourcePath).replace(/\.ts$/, ".js")),
      ),
  };

  function rebuild() {
    cleanElectronTypeScriptOutDirs(root);
    mkdirSync(mainOutDir, { recursive: true });
    for (const sourcePath of inputFiles()) {
      const outputName = basename(sourcePath).replace(/\.ts$/, ".js");
      writeFileSync(
        join(mainOutDir, outputName),
        `compiled:${readFileSync(sourcePath, "utf8")}`,
        "utf8",
      );
    }
  }

  return { sourceDir, mainOutDir, preloadMarker, step, rebuild };
}

describe("dev content build cache", () => {
  it("skips an unchanged step without relying on modification times", () => {
    const fixture = createFixture();
    expect(cache.runCachedBuildStep(fixture.step, fixture.rebuild).status).toBe(
      "built",
    );

    const inputPath = join(fixture.inputDir, "a.txt");
    const future = new Date(Date.now() + 60_000);
    utimesSync(inputPath, future, future);
    const rebuild = vi.fn(fixture.rebuild);

    const result = cache.runCachedBuildStep(fixture.step, rebuild);

    expect(result).toEqual({
      status: "skipped",
      reason: "input and output content are unchanged",
    });
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("rebuilds for changed, added, and deleted input content", () => {
    const fixture = createFixture();
    cache.runCachedBuildStep(fixture.step, fixture.rebuild);
    const originalDate = new Date(1_700_000_000_000);
    const inputPath = join(fixture.inputDir, "a.txt");

    writeFileSync(inputPath, "bravo", "utf8");
    utimesSync(inputPath, originalDate, originalDate);
    expect(cache.planCachedBuildStep(fixture.step)).toMatchObject({
      decision: "build",
      reason: "input content changed",
    });
    cache.runCachedBuildStep(fixture.step, fixture.rebuild);

    const addedPath = join(fixture.inputDir, "b.txt");
    writeFileSync(addedPath, "beta", "utf8");
    expect(cache.planCachedBuildStep(fixture.step)).toMatchObject({
      decision: "build",
      reason: "input content changed",
    });
    cache.runCachedBuildStep(fixture.step, fixture.rebuild);

    unlinkSync(addedPath);
    expect(cache.planCachedBuildStep(fixture.step)).toMatchObject({
      decision: "build",
      reason: "input content changed",
    });
  });

  it("rebuilds when a required output is missing or output bytes changed", () => {
    const fixture = createFixture();
    cache.runCachedBuildStep(fixture.step, fixture.rebuild);
    const outputPath = join(fixture.outputDir, "a.txt");

    unlinkSync(outputPath);
    expect(cache.planCachedBuildStep(fixture.step)).toMatchObject({
      decision: "build",
      reason: "required output is missing: output/a.txt",
    });
    cache.runCachedBuildStep(fixture.step, fixture.rebuild);

    writeFileSync(outputPath, "tampered", "utf8");
    expect(cache.planCachedBuildStep(fixture.step)).toMatchObject({
      decision: "build",
      reason: "output content changed",
    });
  });

  it("detects untracked additions in an owned output tree", () => {
    const fixture = createFixture();
    cache.runCachedBuildStep(fixture.step, fixture.rebuild);

    writeFileSync(join(fixture.outputDir, "stale.txt"), "stale", "utf8");

    expect(cache.planCachedBuildStep(fixture.step)).toMatchObject({
      decision: "build",
      reason: "output content changed",
    });
  });

  it("does not create or replace a successful record after a failed build", () => {
    const emptyCacheFixture = createFixture();
    expect(() =>
      cache.runCachedBuildStep(emptyCacheFixture.step, () => {
        throw new Error("compile failed");
      }),
    ).toThrow("compile failed");
    expect(existsSync(emptyCacheFixture.cacheFile)).toBe(false);

    const fixture = createFixture();
    cache.runCachedBuildStep(fixture.step, fixture.rebuild);
    const successfulRecord = readFileSync(fixture.cacheFile, "utf8");
    writeFileSync(join(fixture.inputDir, "a.txt"), "changed", "utf8");

    expect(() =>
      cache.runCachedBuildStep(fixture.step, () => {
        throw new Error("compile failed");
      }),
    ).toThrow("compile failed");
    expect(readFileSync(fixture.cacheFile, "utf8")).toBe(successfulRecord);
    expect(cache.planCachedBuildStep(fixture.step)).toMatchObject({
      decision: "build",
      reason: "input content changed",
    });
  });

  it("removes stale TypeScript output when a deleted source rebuilds", () => {
    const fixture = createTypeScriptCleanupFixture();
    cache.runCachedBuildStep(fixture.step, fixture.rebuild);
    const removedOutput = join(fixture.mainOutDir, "removed.js");
    expect(existsSync(removedOutput)).toBe(true);

    unlinkSync(join(fixture.sourceDir, "removed.ts"));
    expect(cache.runCachedBuildStep(fixture.step, fixture.rebuild)).toEqual({
      status: "built",
      reason: "input content changed",
    });

    expect(existsSync(join(fixture.mainOutDir, "keep.js"))).toBe(true);
    expect(existsSync(removedOutput)).toBe(false);
    expect(readFileSync(fixture.preloadMarker, "utf8")).toBe("preload");
    expect(cache.planCachedBuildStep(fixture.step).decision).toBe("skip");
  });
});
