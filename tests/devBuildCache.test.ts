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
import { createHash } from "node:crypto";
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
  createElectronCompileCacheStep: (root: string) => CachedBuildStep;
  createRuntimeAssetsCacheStep: (
    root: string,
    outputDir: string,
  ) => CachedBuildStep;
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
const { cleanElectronTypeScriptOutDirs, copyElectronRuntimeSupportFiles } =
  require("../scripts/compile-electron.cjs") as {
    cleanElectronTypeScriptOutDirs: (root?: string) => void;
    copyElectronRuntimeSupportFiles: (root?: string) => void;
  };
const { prepareRuntimeAssets } = require("../scripts/prepare-runtime.cjs") as {
  prepareRuntimeAssets: (options: {
    root: string;
    outputDir: string;
  }) => string;
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

function createElectronCompileCacheFixture() {
  const root = mkdtempSync(temporaryPrefix);
  temporaryRoots.push(root);
  const requiredInputs = [
    join(root, "scripts", "compile-electron.cjs"),
    join(root, "scripts", "dev-build-cache.cjs"),
    join(root, "tsconfig.json"),
    join(root, "tsconfig.electron.json"),
    join(root, "vite.preload.config.ts"),
    join(root, "vite.page-export.config.ts"),
    join(root, "package.json"),
    join(root, "package-lock.json"),
  ];
  for (const filePath of requiredInputs) {
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, "fixture", "utf8");
  }

  const regularMainJson = join(
    root,
    "src",
    "main",
    "runtime",
    "runtime-integrity-manifest.json",
  );
  const runtimeSupportSource = join(
    root,
    "src",
    "main",
    "runtime",
    "python-pip-environment.cjs",
  );
  const fontMatchingMarker = join(
    root,
    "src",
    "main",
    "runtime",
    "font-matching",
    ".font-matching-runtime-artifact-owned.json",
  );
  const fontMatchingContract = join(
    root,
    "src",
    "main",
    "runtime",
    "font-matching",
    "runtime-contract.json",
  );
  const crossScriptProxyMarker = join(
    root,
    "src",
    "main",
    "runtime",
    "font-matching-crossscript-proxy",
    ".owned.json",
  );
  const crossScriptProxyManifest = join(
    root,
    "src",
    "main",
    "runtime",
    "font-matching-crossscript-proxy",
    "runtime-manifest.json",
  );
  const fixtureFiles: Record<string, string> = {
    [join(root, "src", "main", "index.ts")]: "export {};",
    [regularMainJson]: "{}",
    [runtimeSupportSource]: "module.exports = { isolated: true };",
    [fontMatchingMarker]: "{}",
    [fontMatchingContract]: "{}",
    [crossScriptProxyMarker]: "{}",
    [crossScriptProxyManifest]: "{}",
    [join(root, "src", "shared", "messages.json")]: "{}",
    [join(root, "src", "preload", "index.ts")]: "export {};",
    [join(root, "src", "renderer", "src", "page-export.ts")]: "export {};",
  };
  for (const [filePath, contents] of Object.entries(fixtureFiles)) {
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, contents, "utf8");
  }

  return {
    crossScriptProxyManifest,
    crossScriptProxyMarker,
    fontMatchingContract,
    fontMatchingMarker,
    regularMainJson,
    runtimeSupportSource,
    root,
    step: cache.createElectronCompileCacheStep(root),
  };
}

function createRuntimeAssetsCacheFixture() {
  const root = mkdtempSync(temporaryPrefix);
  temporaryRoots.push(root);
  const scriptsDir = join(root, "scripts");
  const sourceDir = join(root, "src", "main", "runtime");
  const outputDir = join(root, "out", "app-runtime");
  const pycacheDir = join(sourceDir, "__pycache__");
  const transportDir = join(sourceDir, "transport");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(pycacheDir, { recursive: true });
  mkdirSync(transportDir, { recursive: true });
  writeFileSync(join(scriptsDir, "prepare-runtime.cjs"), "prepare");
  writeFileSync(join(scriptsDir, "dev-build-cache.cjs"), "cache");
  writeFileSync(join(sourceDir, "root.cjs"), "root");
  writeFileSync(join(sourceDir, "runtime-jsdoc-types.d.ts"), "types");
  writeFileSync(join(transportDir, "response.cjs"), "nested");
  writeFileSync(join(transportDir, "stale.pyc"), "bytecode");
  writeFileSync(join(transportDir, "stale.pyo"), "bytecode");
  const pycacheFile = join(pycacheDir, "runtime.cpython-312.pyc");
  writeFileSync(pycacheFile, "bytecode");
  const fontMatchingBundleDir = addFontMatchingBundle(root);

  const step = cache.createRuntimeAssetsCacheStep(root, outputDir);
  const rebuild = () => {
    prepareRuntimeAssets({ root, outputDir });
  };

  return {
    outputDir,
    pycacheFile,
    sourceDir,
    step,
    rebuild,
    fontMatchingBundleDir,
  };
}

function addFontMatchingBundle(root: string): string {
  const bundleDir = join(
    root,
    "artifacts",
    "font-matching-runtime-active21-v9-r33-page-common-user-v3-release-v2",
  );
  mkdirSync(bundleDir, { recursive: true });
  const artifacts: Record<string, string> = {};
  for (const fileName of [
    "auto-match-active-catalog.json",
    "encoder.onnx",
    "prototype-features.f32",
    "ranker.onnx",
    "selection-calibration.json",
  ]) {
    const bytes = Buffer.from(`sealed:${fileName}`);
    writeFileSync(join(bundleDir, fileName), bytes);
    artifacts[fileName] = createHash("sha256").update(bytes).digest("hex");
  }
  const releaseAcceptance: Record<string, unknown> = {
    record_type: "font_matching_runtime_release_acceptance",
    schema_version: "font-matching-runtime-release-acceptance-v1",
    status: "accepted",
    external_release_quality_gate_passed: true,
    automatic_visual_judgment: false,
    quality_gate: {
      structural_error_count: 0,
      manual_page_verdicts: { accepted: 80, total: 80 },
    },
  };
  releaseAcceptance.record_sha256 = createHash("sha256")
    .update(canonicalJson(releaseAcceptance))
    .digest("hex");
  const runtimeContract = Buffer.from(
    JSON.stringify({
      record_type: "font_matching_runtime_artifact",
      schema_version: "font-matching-runtime-artifact-v2",
      hybrid_score_routing: {
        schema_version: "font-matching-hybrid-score-routing-v1",
        candidate_scores_compatibility_alias: "body_candidate_scores",
        body_candidate_output: "body_candidate_scores",
        variant_candidate_output: "variant_candidate_scores",
        body_roles: ["dialogue", "narration", "thought"],
        variant_roles: [
          "whisper",
          "aside_balloon_edge",
          "emphasis_dialogue",
          "shout",
          "sfx_impact",
          "sfx_motion",
          "sfx_ambient",
          "sfx_emotion",
          "sfx_comic",
          "sign_ui_title",
          "other",
        ],
        unknown_role_fallback: "variant_candidate_scores",
        role_source:
          "resolveCombinedAutomaticFontRole(item.fontRole,pixelRole)",
        selection_feature_source:
          "selected_candidate_scores_with_legacy256_visual_features",
        selection_feature_dim: 256,
        row_specific_rules: false,
      },
      runtime_batching: {
        encoder_batch_size: 2,
        ranker_batch_size: 16,
        parity_qualified: true,
      },
      release_acceptance: releaseAcceptance,
    }),
  );
  writeFileSync(join(bundleDir, "runtime-contract.json"), runtimeContract);
  artifacts["runtime-contract.json"] = createHash("sha256")
    .update(runtimeContract)
    .digest("hex");
  writeFileSync(
    join(bundleDir, ".font-matching-runtime-artifact-owned.json"),
    JSON.stringify({
      owner: "carrot-manga-translator/font-matching-runtime-artifact-v2",
      schema_version: "font-matching-runtime-artifact-v2",
      safe_replace: true,
      artifacts,
    }),
  );
  return bundleDir;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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

  it("leaves model runtime bundles to the runtime-assets cache", () => {
    const fixture = createElectronCompileCacheFixture();
    const inputFiles = fixture.step.getInputFiles();
    const requiredOutputs = fixture.step.getRequiredOutputFiles();

    expect(inputFiles).toContain(fixture.regularMainJson);
    expect(inputFiles).toContain(fixture.runtimeSupportSource);
    expect(inputFiles).not.toContain(fixture.fontMatchingMarker);
    expect(inputFiles).not.toContain(fixture.fontMatchingContract);
    expect(inputFiles).not.toContain(fixture.crossScriptProxyMarker);
    expect(inputFiles).not.toContain(fixture.crossScriptProxyManifest);
    expect(requiredOutputs).toContain(
      join(
        fixture.root,
        "out",
        "main",
        "runtime",
        "runtime-integrity-manifest.json",
      ),
    );
    expect(requiredOutputs).toContain(
      join(
        fixture.root,
        "out",
        "main",
        "runtime",
        "python-pip-environment.cjs",
      ),
    );
    expect(requiredOutputs).not.toContain(
      join(
        fixture.root,
        "out",
        "main",
        "runtime",
        "font-matching",
        ".font-matching-runtime-artifact-owned.json",
      ),
    );
    expect(requiredOutputs).not.toContain(
      join(
        fixture.root,
        "out",
        "main",
        "runtime",
        "font-matching",
        "runtime-contract.json",
      ),
    );
    expect(requiredOutputs).not.toContain(
      join(
        fixture.root,
        "out",
        "main",
        "runtime",
        "font-matching-crossscript-proxy",
        ".owned.json",
      ),
    );
    expect(requiredOutputs).not.toContain(
      join(
        fixture.root,
        "out",
        "main",
        "runtime",
        "font-matching-crossscript-proxy",
        "runtime-manifest.json",
      ),
    );
  });

  it("copies the allowlisted CommonJS runtime support into out/main", () => {
    const fixture = createElectronCompileCacheFixture();

    copyElectronRuntimeSupportFiles(fixture.root);

    expect(
      readFileSync(
        join(
          fixture.root,
          "out",
          "main",
          "runtime",
          "python-pip-environment.cjs",
        ),
        "utf8",
      ),
    ).toBe(readFileSync(fixture.runtimeSupportSource, "utf8"));
  });

  it("uses the runtime preparer's development-file exclusions", () => {
    const fixture = createRuntimeAssetsCacheFixture();

    expect(
      cache.runCachedBuildStep(fixture.step, fixture.rebuild),
    ).toMatchObject({
      status: "built",
    });
    expect(readFileSync(join(fixture.outputDir, "root.cjs"), "utf8")).toBe(
      "root",
    );
    expect(
      readFileSync(
        join(fixture.outputDir, "transport", "response.cjs"),
        "utf8",
      ),
    ).toBe("nested");
    expect(
      existsSync(join(fixture.outputDir, "runtime-jsdoc-types.d.ts")),
    ).toBe(false);
    expect(existsSync(join(fixture.outputDir, "transport", "stale.pyc"))).toBe(
      false,
    );
    expect(existsSync(join(fixture.outputDir, "transport", "stale.pyo"))).toBe(
      false,
    );
    expect(existsSync(join(fixture.outputDir, "__pycache__"))).toBe(false);

    expect(cache.runCachedBuildStep(fixture.step, fixture.rebuild)).toEqual({
      status: "skipped",
      reason: "input and output content are unchanged",
    });

    writeFileSync(fixture.pycacheFile, "changed bytecode");
    expect(cache.planCachedBuildStep(fixture.step).decision).toBe("skip");

    writeFileSync(join(fixture.sourceDir, "root.cjs"), "changed root");
    expect(cache.runCachedBuildStep(fixture.step, fixture.rebuild)).toEqual({
      status: "built",
      reason: "input content changed",
    });
    expect(readFileSync(join(fixture.outputDir, "root.cjs"), "utf8")).toBe(
      "changed root",
    );
  });

  it("rebuilds and stages the schema-v2 release-v1 bundle when it changes", () => {
    const fixture = createRuntimeAssetsCacheFixture();
    cache.runCachedBuildStep(fixture.step, fixture.rebuild);
    expect(cache.planCachedBuildStep(fixture.step).decision).toBe("skip");

    const bundleDir = fixture.fontMatchingBundleDir;
    const rankerPath = join(bundleDir, "ranker.onnx");
    const rankerBytes = Buffer.from("sealed-updated:ranker.onnx");
    writeFileSync(rankerPath, rankerBytes);
    const markerPath = join(
      bundleDir,
      ".font-matching-runtime-artifact-owned.json",
    );
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      artifacts: Record<string, string>;
    };
    marker.artifacts["ranker.onnx"] = createHash("sha256")
      .update(rankerBytes)
      .digest("hex");
    writeFileSync(markerPath, JSON.stringify(marker));
    expect(cache.planCachedBuildStep(fixture.step)).toMatchObject({
      decision: "build",
      reason: "input content changed",
    });

    expect(
      cache.runCachedBuildStep(fixture.step, fixture.rebuild),
    ).toMatchObject({ status: "built" });
    expect(
      readFileSync(
        join(fixture.outputDir, "font-matching", "ranker.onnx"),
        "utf8",
      ),
    ).toBe(readFileSync(join(bundleDir, "ranker.onnx"), "utf8"));
    expect(cache.planCachedBuildStep(fixture.step).decision).toBe("skip");
  });
});
