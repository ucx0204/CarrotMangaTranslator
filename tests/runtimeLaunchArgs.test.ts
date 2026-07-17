import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_12B_FILE,
  DEFAULT_12B_MMPROJ_FILE,
  DEFAULT_12B_MMPROJ_REPO,
  DEFAULT_12B_REPO,
  DEFAULT_26B_FILE,
  DEFAULT_26B_MMPROJ_FILE,
  DEFAULT_26B_MMPROJ_REPO,
  DEFAULT_26B_REPO,
  DEFAULT_31B_FILE,
  DEFAULT_31B_REPO,
  DEFAULT_DRAFT_FILE,
  DEFAULT_DRAFT_REPO,
  DEFAULT_MMPROJ_FILE,
  DEFAULT_MMPROJ_REPO,
  buildLaunchArgs,
  collectRequiredHfDownloads,
  createTempDir,
  ensureHfModelAssetsDownloaded,
  inspectModelLaunch,
  isModelCached,
  resolveLegacyManagedHfFilePath,
  resolveManagedHfFilePath,
  writeCachedAssets,
} from "./helpers/runtimeModelContracts";

describe("runtime launch argument contracts", () => {
  it("launches an explicitly configured local GGUF without Hugging Face flags", () => {
    const localDir = createTempDir("local-model-");
    const modelPath = join(localDir, "custom-vision-model.gguf");
    const mmprojPath = join(localDir, "mmproj-BF16.gguf");
    writeFileSync(modelPath, "model");
    writeFileSync(mmprojPath, "mmproj");

    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      ctx: 16384,
      batch: 32,
      ubatch: 32,
      modelSource: "local",
      localModelPath: modelPath,
      localMmprojPath: mmprojPath,
    });

    expect(args).toContain("-m");
    expect(args).toContain(modelPath);
    expect(args).toContain("--mmproj");
    expect(args).toContain(mmprojPath);
    expect(args).toContain("--no-mmproj-offload");
    expect(args).not.toContain("--mmproj-offload");
    expect(args).toContain("--no-warmup");
    expect(args).not.toContain("--n-cpu-moe");
    expect(args).not.toContain("--chat-template-kwargs");
    expect(
      args.slice(
        args.indexOf("--repeat-penalty"),
        args.indexOf("--repeat-penalty") + 2,
      ),
    ).toEqual(["--repeat-penalty", "1.08"]);
    expect(args).not.toContain("-hf");
    expect(args).not.toContain("-hff");
    expect(
      isModelCached({ modelSource: "local", localModelPath: modelPath }),
    ).toBe(true);
  });

  it("passes VRAM economy cache options to llama-server without clipping image tokens", () => {
    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 1024,
      ctx: 8192,
      batch: 1024,
      ubatch: 1024,
      cacheTypeK: "q4_0",
      cacheTypeV: "q4_0",
      ctxCheckpoints: 0,
      kvOffload: true,
      mmprojOffload: false,
      enableMetrics: true,
      enablePerf: true,
      imageMinTokens: 1024,
      imageMaxTokens: 1024,
      modelRepo: DEFAULT_31B_REPO,
      modelFile: DEFAULT_31B_FILE,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE,
    });

    expect(
      args.slice(
        args.indexOf("--cache-type-k"),
        args.indexOf("--cache-type-k") + 2,
      ),
    ).toEqual(["--cache-type-k", "q4_0"]);
    expect(
      args.slice(
        args.indexOf("--cache-type-v"),
        args.indexOf("--cache-type-v") + 2,
      ),
    ).toEqual(["--cache-type-v", "q4_0"]);
    expect(
      args.slice(
        args.indexOf("--ctx-checkpoints"),
        args.indexOf("--ctx-checkpoints") + 2,
      ),
    ).toEqual(["--ctx-checkpoints", "0"]);
    expect(args).toContain("--no-mmproj-offload");
    expect(args).toContain("--metrics");
    expect(args).toContain("--perf");
    expect(args).toContain("--kv-offload");
    expect(args).toContain("--kv-unified");
    expect(args).toContain("--jinja");
    expect(args).toContain("--no-mmap");
    expect(args).toContain("--mlock");
    expect(args).toContain("--no-host");
    expect(args).not.toContain("--no-kv-offload");
    expect(args).not.toContain("--fit");
    expect(args).not.toContain("--no-cache-prompt");
    expect(args).not.toContain("--no-warmup");
    expect(args.slice(args.indexOf("-ngl"), args.indexOf("-ngl") + 2)).toEqual([
      "-ngl",
      "all",
    ]);
    expect(args.slice(args.indexOf("-b"), args.indexOf("-b") + 2)).toEqual([
      "-b",
      "1024",
    ]);
    expect(args.slice(args.indexOf("-ub"), args.indexOf("-ub") + 2)).toEqual([
      "-ub",
      "1024",
    ]);
    expect(
      args.slice(
        args.indexOf("--image-min-tokens"),
        args.indexOf("--image-min-tokens") + 2,
      ),
    ).toEqual(["--image-min-tokens", "1024"]);
    expect(
      args.slice(
        args.indexOf("--image-max-tokens"),
        args.indexOf("--image-max-tokens") + 2,
      ),
    ).toEqual(["--image-max-tokens", "1024"]);
    expect(
      args.slice(args.indexOf("--temp"), args.indexOf("--temp") + 2),
    ).toEqual(["--temp", "0.2"]);
    expect(
      args.slice(args.indexOf("--top-k"), args.indexOf("--top-k") + 2),
    ).toEqual(["--top-k", "64"]);
    expect(
      args.slice(args.indexOf("--top-p"), args.indexOf("--top-p") + 2),
    ).toEqual(["--top-p", "0.95"]);
    expect(
      args.slice(args.indexOf("--min-p"), args.indexOf("--min-p") + 2),
    ).toEqual(["--min-p", "0.0"]);
  });

  it("passes economy performance tuning launch options when explicitly configured", () => {
    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 1024,
      ctx: 8192,
      batch: 1024,
      ubatch: 1024,
      cacheTypeK: "q4_0",
      cacheTypeV: "q4_0",
      threadsBatch: 16,
      poll: 100,
      pollBatch: true,
      prioBatch: 2,
      cacheIdleSlots: false,
      cacheReuse: 128,
      enableMetrics: true,
      enablePerf: false,
      modelRepo: DEFAULT_31B_REPO,
      modelFile: DEFAULT_31B_FILE,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE,
    });

    expect(
      args.slice(
        args.indexOf("--threads-batch"),
        args.indexOf("--threads-batch") + 2,
      ),
    ).toEqual(["--threads-batch", "16"]);
    expect(
      args.slice(args.indexOf("--poll"), args.indexOf("--poll") + 2),
    ).toEqual(["--poll", "100"]);
    expect(
      args.slice(
        args.indexOf("--poll-batch"),
        args.indexOf("--poll-batch") + 2,
      ),
    ).toEqual(["--poll-batch", "1"]);
    expect(
      args.slice(
        args.indexOf("--prio-batch"),
        args.indexOf("--prio-batch") + 2,
      ),
    ).toEqual(["--prio-batch", "2"]);
    expect(args).toContain("--no-cache-idle-slots");
    expect(
      args.slice(
        args.indexOf("--cache-reuse"),
        args.indexOf("--cache-reuse") + 2,
      ),
    ).toEqual(["--cache-reuse", "128"]);
    expect(args).toContain("--metrics");
    expect(args).toContain("--no-perf");
  });

  it("launches the 26B economy preset on mainline llama instead of beellama-only flags", () => {
    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 2048,
      ctx: 8192,
      batch: 1024,
      ubatch: 1024,
      cacheTypeK: "q4_0",
      cacheTypeV: "q4_0",
      ctxCheckpoints: 0,
      kvOffload: true,
      mmprojOffload: true,
      gpuLayers: "fit",
      enableMetrics: true,
      enablePerf: true,
      imageMinTokens: 1024,
      imageMaxTokens: 1024,
      modelRepo: DEFAULT_26B_REPO,
      modelFile: DEFAULT_26B_FILE,
      mmprojRepo: DEFAULT_26B_MMPROJ_REPO,
      mmprojFile: DEFAULT_26B_MMPROJ_FILE,
    });

    expect(args).toContain("--fit");
    expect(
      args.slice(
        args.indexOf("--fit-target"),
        args.indexOf("--fit-target") + 2,
      ),
    ).toEqual(["--fit-target", "2048"]);
    expect(args.slice(args.indexOf("-ngl"), args.indexOf("-ngl") + 2)).toEqual([
      "-ngl",
      "auto",
    ]);
    expect(args).toContain("--no-cache-prompt");
    expect(args).toContain("--no-warmup");
    expect(args).toContain("--mmproj-offload");
    expect(args).not.toContain("--kv-unified");
    expect(args).not.toContain("--jinja");
    expect(args).not.toContain("--no-mmap");
    expect(args).not.toContain("--mlock");
    expect(args).not.toContain("--no-host");
  });

  it("launches the 12B minimum preset on mainline llama instead of beellama-only flags", () => {
    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 2048,
      ctx: 8192,
      batch: 1024,
      ubatch: 1024,
      cacheTypeK: "q4_0",
      cacheTypeV: "q4_0",
      ctxCheckpoints: 0,
      kvOffload: true,
      mmprojOffload: true,
      gpuLayers: "fit",
      enableMetrics: true,
      enablePerf: true,
      imageMinTokens: 1024,
      imageMaxTokens: 1024,
      modelRepo: DEFAULT_12B_REPO,
      modelFile: DEFAULT_12B_FILE,
      mmprojRepo: DEFAULT_12B_MMPROJ_REPO,
      mmprojFile: DEFAULT_12B_MMPROJ_FILE,
    });

    expect(args).toContain("--fit");
    expect(
      args.slice(
        args.indexOf("--fit-target"),
        args.indexOf("--fit-target") + 2,
      ),
    ).toEqual(["--fit-target", "2048"]);
    expect(args.slice(args.indexOf("-ngl"), args.indexOf("-ngl") + 2)).toEqual([
      "-ngl",
      "auto",
    ]);
    expect(args).toContain("--no-cache-prompt");
    expect(args).toContain("--no-warmup");
    expect(args).toContain("--mmproj-offload");
    expect(args).not.toContain("--kv-unified");
    expect(args).not.toContain("--jinja");
    expect(args).not.toContain("--no-mmap");
    expect(args).not.toContain("--mlock");
    expect(args).not.toContain("--no-host");
  });

  it("passes the full VRAM smoke DFlash draft options to llama-server", () => {
    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      ctx: 16384,
      batch: 2048,
      ubatch: 1536,
      cacheTypeK: "q4_0",
      cacheTypeV: "q4_0",
      ctxCheckpoints: 0,
      mmprojOffload: false,
      enableMetrics: true,
      enablePerf: true,
      useDraft: true,
      draftModelRepo: DEFAULT_DRAFT_REPO,
      draftModelFile: DEFAULT_DRAFT_FILE,
      imageMinTokens: 1024,
      imageMaxTokens: 1024,
      modelRepo: DEFAULT_31B_REPO,
      modelFile: DEFAULT_31B_FILE,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE,
    });

    expect(args).toContain("--no-mmproj-offload");
    expect(args).toContain("--metrics");
    expect(args).toContain("--perf");
    expect(args.slice(args.indexOf("-ngl"), args.indexOf("-ngl") + 2)).toEqual([
      "-ngl",
      "all",
    ]);
    expect(args.slice(args.indexOf("-b"), args.indexOf("-b") + 2)).toEqual([
      "-b",
      "2048",
    ]);
    expect(args.slice(args.indexOf("-ub"), args.indexOf("-ub") + 2)).toEqual([
      "-ub",
      "1536",
    ]);
    expect(args.slice(args.indexOf("-np"), args.indexOf("-np") + 2)).toEqual([
      "-np",
      "1",
    ]);
    expect(
      args.slice(
        args.indexOf("--ctx-checkpoints"),
        args.indexOf("--ctx-checkpoints") + 2,
      ),
    ).toEqual(["--ctx-checkpoints", "0"]);
    const draftFlagIndex = args.findIndex(
      (arg) => arg === "--spec-draft-hf" || arg === "--spec-draft-model",
    );
    expect(draftFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[draftFlagIndex + 1]).toSatisfy(
      (value: string) =>
        value === `${DEFAULT_DRAFT_REPO}:IQ4_XS` ||
        value.endsWith(DEFAULT_DRAFT_FILE),
    );
    expect(args).toContain("--spec-type");
    expect(args).toContain("dflash");
    expect(args).toContain("--spec-dflash-cross-ctx");
    expect(args).toContain("--spec-draft-ngl");
    expect(args).toContain("all");
    expect(args).toContain("--spec-draft-n-max");
    expect(args).toContain("16");
    expect(args).toContain("--spec-branch-budget");
    expect(args).toContain("0");
    expect(args).toContain("--kv-unified");
    expect(args).toContain("--jinja");
    expect(args).toContain("--no-mmap");
    expect(args).toContain("--mlock");
    expect(args).toContain("--no-host");
    expect(args).not.toContain("--n-cpu-moe");
    expect(args).not.toContain("--chat-template-kwargs");
  });

  it("keeps BeeLlama DFlash launch flags for the ROCm HIP runtime", () => {
    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      ctx: 16384,
      batch: 2048,
      ubatch: 1536,
      cacheTypeK: "q4_0",
      cacheTypeV: "q4_0",
      ctxCheckpoints: 0,
      mmprojOffload: false,
      enableMetrics: true,
      enablePerf: true,
      llamaRuntimeProfile: "rocm",
      serverPath:
        "C:/app-data/tools/beellama-v0.3.1-hip-radeon/llama-server.exe",
      useDraft: true,
      draftModelRepo: DEFAULT_DRAFT_REPO,
      draftModelFile: DEFAULT_DRAFT_FILE,
      imageMinTokens: 1024,
      imageMaxTokens: 1024,
      modelRepo: DEFAULT_31B_REPO,
      modelFile: DEFAULT_31B_FILE,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE,
    });

    expect(args).toContain("--spec-type");
    expect(args).toContain("dflash");
    expect(args).toContain("--spec-dflash-cross-ctx");
    expect(args).toContain("--spec-branch-budget");
    expect(args).toContain("--kv-unified");
    expect(args).toContain("--jinja");
    expect(args).toContain("--no-mmap");
    expect(args).toContain("--mlock");
    expect(args).toContain("--no-host");
    expect(args).not.toContain("--fit");
    expect(args).not.toContain("--no-cache-prompt");
    expect(args).not.toContain("--no-warmup");
  });

  it("launches from app-managed HF cache files after direct download", () => {
    const hubCacheDir = createTempDir("hf-managed-cache-");
    const options = {
      port: 18180,
      fitTargetMb: 4096,
      ctx: 16384,
      batch: 2048,
      ubatch: 1536,
      useDraft: true,
      modelRepo: DEFAULT_31B_REPO,
      modelFile: DEFAULT_31B_FILE,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE,
      draftModelRepo: DEFAULT_DRAFT_REPO,
      draftModelFile: DEFAULT_DRAFT_FILE,
      hfHubCacheDir: hubCacheDir,
    };
    const modelPath = resolveManagedHfFilePath(
      options,
      DEFAULT_31B_REPO,
      DEFAULT_31B_FILE,
    );
    const mmprojPath = resolveManagedHfFilePath(
      options,
      DEFAULT_MMPROJ_REPO,
      DEFAULT_MMPROJ_FILE,
    );
    const draftPath = resolveManagedHfFilePath(
      options,
      DEFAULT_DRAFT_REPO,
      DEFAULT_DRAFT_FILE,
    );
    for (const filePath of [modelPath, mmprojPath, draftPath]) {
      if (!filePath) {
        throw new Error("managed path not resolved");
      }
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, "cached");
    }

    const args = buildLaunchArgs(options);

    expect(args).toContain("-m");
    expect(args).toContain(modelPath);
    expect(args).toContain("--mmproj");
    expect(args).toContain(mmprojPath);
    expect(args).toContain("--spec-draft-model");
    expect(args).toContain(draftPath);
    expect(args).not.toContain("-hf");
    expect(args).not.toContain("-hff");
    expect(args).not.toContain("--mmproj-url");
    expect(args).not.toContain("--spec-draft-hf");
    expect(isModelCached(options)).toBe(true);
  });

  it("keeps the reported 31B Windows cache paths below MAX_PATH", () => {
    const options = {
      hfHubCacheDir:
        "C:\\Users\\Administrator\\AppData\\Local\\Programs\\carrot-manga-translator\\data\\hf-cache\\hub",
    };
    const legacyModelPath = resolveLegacyManagedHfFilePath(
      options,
      DEFAULT_31B_REPO,
      DEFAULT_31B_FILE,
    );
    const legacyMmprojPath = resolveLegacyManagedHfFilePath(
      options,
      DEFAULT_MMPROJ_REPO,
      DEFAULT_MMPROJ_FILE,
    );
    const modelPath = resolveManagedHfFilePath(
      options,
      DEFAULT_31B_REPO,
      DEFAULT_31B_FILE,
    );
    const mmprojPath = resolveManagedHfFilePath(
      options,
      DEFAULT_MMPROJ_REPO,
      DEFAULT_MMPROJ_FILE,
    );

    expect(legacyModelPath?.length).toBeGreaterThanOrEqual(260);
    expect(legacyMmprojPath?.length).toBeGreaterThanOrEqual(260);
    expect(modelPath?.length).toBeLessThan(260);
    expect(mmprojPath?.length).toBeLessThan(260);
    expect(() =>
      resolveLegacyManagedHfFilePath(
        options,
        "owner\\..\\..\\escape",
        "model.gguf",
      ),
    ).toThrow(/Invalid Hugging Face repository ID/);
  });

  it("migrates legacy managed cache files without downloading them again", async () => {
    const hubCacheDir = createTempDir("hf-legacy-managed-cache-");
    const options = {
      useDraft: true,
      modelRepo: DEFAULT_31B_REPO,
      modelFile: DEFAULT_31B_FILE,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE,
      draftModelRepo: DEFAULT_DRAFT_REPO,
      draftModelFile: DEFAULT_DRAFT_FILE,
      hfHubCacheDir: hubCacheDir,
    };
    const assets = [
      [DEFAULT_31B_REPO, DEFAULT_31B_FILE],
      [DEFAULT_MMPROJ_REPO, DEFAULT_MMPROJ_FILE],
      [DEFAULT_DRAFT_REPO, DEFAULT_DRAFT_FILE],
    ] as const;
    const legacyPaths = assets.map(([repo, file]) =>
      resolveLegacyManagedHfFilePath(options, repo, file),
    );
    const compactPaths = assets.map(([repo, file]) =>
      resolveManagedHfFilePath(options, repo, file),
    );
    for (const filePath of legacyPaths) {
      if (!filePath) {
        throw new Error("legacy managed path not resolved");
      }
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, "cached");
    }
    const standardSnapshotDir = writeCachedAssets({
      hubCacheDir,
      repoId: DEFAULT_31B_REPO,
      snapshot: "snapshot-newer",
      modelFile: DEFAULT_31B_FILE,
      includeMmproj: false,
    });

    expect(isModelCached(options)).toBe(true);
    await ensureHfModelAssetsDownloaded(options, inspectModelLaunch(options));

    for (const filePath of legacyPaths) {
      expect(filePath && existsSync(filePath)).toBe(false);
    }
    for (const filePath of compactPaths) {
      expect(filePath && existsSync(filePath)).toBe(true);
    }
    expect(existsSync(join(standardSnapshotDir, DEFAULT_31B_FILE))).toBe(true);
    const launchTarget = inspectModelLaunch(options);
    expect(launchTarget.modelPath).toBe(compactPaths[0]);
    expect(launchTarget.mmprojPath).toBe(compactPaths[1]);
    expect(launchTarget.draftModelPath).toBe(compactPaths[2]);
    expect(launchTarget.requiresDownload).toBe(false);
  });

  it("hard-links long standard HF snapshot paths into the compact cache on Windows", async () => {
    if (process.platform !== "win32") {
      return;
    }
    const cacheRoot = createTempDir("hf-standard-long-cache-");
    const hubCacheDir = join(cacheRoot, `nested-${"x".repeat(90)}`);
    const options = {
      modelRepo: DEFAULT_31B_REPO,
      modelFile: DEFAULT_31B_FILE,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE,
      hfHubCacheDir: hubCacheDir,
    };
    const modelSnapshotDir = writeCachedAssets({
      hubCacheDir,
      repoId: DEFAULT_31B_REPO,
      snapshot: "standard-model",
      modelFile: DEFAULT_31B_FILE,
      includeMmproj: false,
    });
    const mmprojSnapshotDir = writeCachedAssets({
      hubCacheDir,
      repoId: DEFAULT_MMPROJ_REPO,
      snapshot: "standard-mmproj",
      modelFile: DEFAULT_MMPROJ_FILE,
      includeMmproj: false,
    });
    const standardModelPath = join(modelSnapshotDir, DEFAULT_31B_FILE);
    const standardMmprojPath = join(mmprojSnapshotDir, DEFAULT_MMPROJ_FILE);
    const compactModelPath = resolveManagedHfFilePath(
      options,
      DEFAULT_31B_REPO,
      DEFAULT_31B_FILE,
    );
    const compactMmprojPath = resolveManagedHfFilePath(
      options,
      DEFAULT_MMPROJ_REPO,
      DEFAULT_MMPROJ_FILE,
    );

    expect(standardModelPath.length).toBeGreaterThanOrEqual(260);
    expect(standardMmprojPath.length).toBeGreaterThanOrEqual(260);
    await ensureHfModelAssetsDownloaded(options, inspectModelLaunch(options));

    expect(existsSync(standardModelPath)).toBe(true);
    expect(existsSync(standardMmprojPath)).toBe(true);
    expect(compactModelPath && existsSync(compactModelPath)).toBe(true);
    expect(compactMmprojPath && existsSync(compactMmprojPath)).toBe(true);
    const launchTarget = inspectModelLaunch(options);
    expect(launchTarget.modelPath).toBe(compactModelPath);
    expect(launchTarget.mmprojPath).toBe(compactMmprojPath);
  });

  it("hard-links a long custom HF model without a configured mmproj on Windows", async () => {
    if (process.platform !== "win32") {
      return;
    }
    const cacheRoot = createTempDir("hf-custom-long-cache-");
    const hubCacheDir = join(cacheRoot, `nested-${"x".repeat(90)}`);
    const repoId = `custom-owner/${"r".repeat(40)}`;
    const modelFile = `custom-${"m".repeat(40)}.gguf`;
    const options = {
      modelRepo: repoId,
      modelFile,
      hfHubCacheDir: hubCacheDir,
    };
    const snapshotDir = writeCachedAssets({
      hubCacheDir,
      repoId,
      snapshot: "custom-text-only",
      modelFile,
      includeMmproj: false,
    });
    const standardModelPath = join(snapshotDir, modelFile);
    const compactModelPath = resolveManagedHfFilePath(
      options,
      repoId,
      modelFile,
    );

    expect(standardModelPath.length).toBeGreaterThanOrEqual(260);
    expect(compactModelPath?.length).toBeLessThan(260);
    expect(inspectModelLaunch(options).mmprojPath).toBeNull();
    await ensureHfModelAssetsDownloaded(options, inspectModelLaunch(options));

    expect(existsSync(standardModelPath)).toBe(true);
    expect(compactModelPath && existsSync(compactModelPath)).toBe(true);
    const launchTarget = inspectModelLaunch(options);
    expect(launchTarget.modelPath).toBe(compactModelPath);
    expect(launchTarget.mmprojPath).toBeNull();
  });

  it("migrates an app-managed draft model used with a local main model", async () => {
    const hubCacheDir = createTempDir("hf-local-draft-cache-");
    const localDir = createTempDir("local-main-model-");
    const localModelPath = join(localDir, "model.gguf");
    writeFileSync(localModelPath, "local model");
    const options = {
      modelSource: "local",
      localModelPath,
      useDraft: true,
      draftModelRepo: DEFAULT_DRAFT_REPO,
      draftModelFile: DEFAULT_DRAFT_FILE,
      hfHubCacheDir: hubCacheDir,
    };
    const legacyDraftPath = resolveLegacyManagedHfFilePath(
      options,
      DEFAULT_DRAFT_REPO,
      DEFAULT_DRAFT_FILE,
    );
    const compactDraftPath = resolveManagedHfFilePath(
      options,
      DEFAULT_DRAFT_REPO,
      DEFAULT_DRAFT_FILE,
    );
    if (!legacyDraftPath || !compactDraftPath) {
      throw new Error("managed draft path not resolved");
    }
    mkdirSync(join(legacyDraftPath, ".."), { recursive: true });
    writeFileSync(legacyDraftPath, "draft");

    await ensureHfModelAssetsDownloaded(options, inspectModelLaunch(options));

    expect(existsSync(legacyDraftPath)).toBe(false);
    expect(existsSync(compactDraftPath)).toBe(true);
    expect(inspectModelLaunch(options).draftModelPath).toBe(compactDraftPath);
  });

  it("does not accept a zero-byte legacy cache file as a model", () => {
    const hubCacheDir = createTempDir("hf-empty-legacy-cache-");
    const options = {
      modelRepo: "custom/empty-model",
      modelFile: "empty.gguf",
      hfHubCacheDir: hubCacheDir,
    };
    const legacyModelPath = resolveLegacyManagedHfFilePath(
      options,
      options.modelRepo,
      options.modelFile,
    );
    if (!legacyModelPath) {
      throw new Error("legacy model path not resolved");
    }
    mkdirSync(join(legacyModelPath, ".."), { recursive: true });
    writeFileSync(legacyModelPath, "");

    expect(isModelCached(options)).toBe(false);
    expect(
      collectRequiredHfDownloads(options).map((task) => task.kind),
    ).toEqual(["model"]);
  });

  it("collects only the HF files needed by the selected VRAM mode", () => {
    const hubCacheDir = createTempDir("hf-download-plan-");
    const llamaCacheDir = createTempDir("llama-download-plan-");
    const baseOptions = {
      modelRepo: DEFAULT_31B_REPO,
      modelFile: DEFAULT_31B_FILE,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE,
      draftModelRepo: DEFAULT_DRAFT_REPO,
      draftModelFile: DEFAULT_DRAFT_FILE,
      hfHubCacheDir: hubCacheDir,
      llamaCacheDir,
    };

    expect(
      collectRequiredHfDownloads({ ...baseOptions, useDraft: false }).map(
        (task) => task.kind,
      ),
    ).toEqual(["model", "mmproj"]);
    expect(
      collectRequiredHfDownloads({ ...baseOptions, useDraft: true }).map(
        (task) => task.kind,
      ),
    ).toEqual(["model", "mmproj", "draft"]);
  });

  it("downloads the canonical uppercase 12B mmproj after the upstream replacement", () => {
    const hubCacheDir = createTempDir("hf-12b-mmproj-plan-");
    const options = {
      modelRepo: DEFAULT_12B_REPO,
      modelFile: DEFAULT_12B_FILE,
      mmprojRepo: DEFAULT_12B_MMPROJ_REPO,
      mmprojFile: DEFAULT_12B_MMPROJ_FILE,
      hfHubCacheDir: hubCacheDir,
    };
    const mmprojTask = collectRequiredHfDownloads(options).find(
      (task) => task.kind === "mmproj",
    );
    expect(mmprojTask).toMatchObject({
      repo: DEFAULT_12B_MMPROJ_REPO,
      file: "mmproj-gemma-4-12B-it-BF16.gguf",
      url: `https://huggingface.co/${DEFAULT_12B_MMPROJ_REPO}/resolve/main/mmproj-gemma-4-12B-it-BF16.gguf`,
    });
  });

  it("reuses the known-working lowercase 12B mmproj as a cache-only alias", () => {
    const hubCacheDir = createTempDir("hf-12b-mmproj-legacy-");
    const options = {
      modelRepo: DEFAULT_12B_REPO,
      modelFile: DEFAULT_12B_FILE,
      mmprojRepo: DEFAULT_12B_MMPROJ_REPO,
      mmprojFile: DEFAULT_12B_MMPROJ_FILE,
      hfHubCacheDir: hubCacheDir,
    };
    const legacyMmprojPath = resolveManagedHfFilePath(
      options,
      DEFAULT_12B_MMPROJ_REPO,
      "mmproj-gemma-4-12B-it-bf16.gguf",
    );
    if (!legacyMmprojPath) {
      throw new Error("legacy 12B mmproj path not resolved");
    }
    mkdirSync(join(legacyMmprojPath, ".."), { recursive: true });
    writeFileSync(legacyMmprojPath, "known-working legacy mmproj");

    expect(inspectModelLaunch(options).mmprojPath).toBe(legacyMmprojPath);
    expect(
      collectRequiredHfDownloads(options).some(
        (task) => task.kind === "mmproj",
      ),
    ).toBe(false);
  });

  it("prefers the canonical 12B mmproj cache over its legacy alias", () => {
    const hubCacheDir = createTempDir("hf-12b-mmproj-preferred-");
    const options = {
      modelRepo: DEFAULT_12B_REPO,
      modelFile: DEFAULT_12B_FILE,
      mmprojRepo: DEFAULT_12B_MMPROJ_REPO,
      mmprojFile: DEFAULT_12B_MMPROJ_FILE,
      hfHubCacheDir: hubCacheDir,
    };
    const canonicalPath = resolveManagedHfFilePath(
      options,
      DEFAULT_12B_MMPROJ_REPO,
      DEFAULT_12B_MMPROJ_FILE,
    );
    const legacyPath = resolveManagedHfFilePath(
      options,
      DEFAULT_12B_MMPROJ_REPO,
      "mmproj-gemma-4-12B-it-bf16.gguf",
    );
    if (!canonicalPath || !legacyPath) {
      throw new Error("12B mmproj cache paths not resolved");
    }
    mkdirSync(join(canonicalPath, ".."), { recursive: true });
    writeFileSync(canonicalPath, "canonical mmproj");
    writeFileSync(legacyPath, "legacy mmproj");

    expect(inspectModelLaunch(options).mmprojPath).toBe(canonicalPath);
  });

  it("can explicitly offload the multimodal projector to GPU for diagnostics", () => {
    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 1024,
      ctx: 8192,
      batch: 512,
      ubatch: 512,
      mmprojOffload: true,
      modelRepo: DEFAULT_31B_REPO,
      modelFile: DEFAULT_31B_FILE,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE,
    });

    expect(args).toContain("--mmproj-offload");
    expect(args).not.toContain("--no-mmproj-offload");
  });

  it("prefers sibling cached mmproj paths for custom cached HF models", () => {
    const hubCacheDir = createTempDir("hf-cache-");
    const modelFile = "custom-vision-model.gguf";
    const repoId = "custom/vision-model";
    const snapshotDir = writeCachedAssets({
      hubCacheDir,
      repoId,
      snapshot: "snapshot-new",
      modelFile,
    });

    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      ctx: 16384,
      batch: 32,
      ubatch: 32,
      modelRepo: repoId,
      modelFile,
      hfHubCacheDir: hubCacheDir,
    });

    expect(args).toContain("-m");
    expect(args).toContain(join(snapshotDir, modelFile));
    expect(args).toContain("--mmproj");
    expect(args).toContain(join(snapshotDir, "mmproj-BF16.gguf"));
    expect(args).not.toContain("-hf");
    expect(args).not.toContain("-hff");
    expect(
      isModelCached({
        modelRepo: repoId,
        modelFile,
        hfHubCacheDir: hubCacheDir,
      }),
    ).toBe(true);
  });

  it("uses a cached HF model with mmproj-url when the separate mmproj is not cached yet", () => {
    const hubCacheDir = createTempDir("hf-cache-");
    const llamaCacheDir = createTempDir("llama-cache-empty-");
    const modelFile = DEFAULT_31B_FILE;
    const repoId = DEFAULT_31B_REPO;
    const snapshotDir = writeCachedAssets({
      hubCacheDir,
      repoId,
      snapshot: "snapshot-model-only",
      modelFile,
      includeMmproj: false,
    });

    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      ctx: 16384,
      batch: 32,
      ubatch: 32,
      modelRepo: repoId,
      modelFile,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE,
      hfHubCacheDir: hubCacheDir,
      llamaCacheDir,
    });

    expect(args).toContain("-m");
    expect(args).toContain(join(snapshotDir, modelFile));
    expect(args).toContain("--mmproj-url");
    expect(args).toContain(
      `https://huggingface.co/${DEFAULT_MMPROJ_REPO}/resolve/main/${encodeURIComponent(DEFAULT_MMPROJ_FILE)}`,
    );
    expect(args).not.toContain("-hf");
    expect(args).not.toContain("-hff");
    expect(
      isModelCached({
        modelRepo: repoId,
        modelFile,
        mmprojRepo: DEFAULT_MMPROJ_REPO,
        mmprojFile: DEFAULT_MMPROJ_FILE,
        hfHubCacheDir: hubCacheDir,
        llamaCacheDir,
      }),
    ).toBe(false);
  });

  it("treats beellama's llama.cpp mmproj cache as already downloaded", () => {
    const hubCacheDir = createTempDir("hf-cache-");
    const llamaCacheDir = createTempDir("llama-cache-");
    const modelFile = DEFAULT_31B_FILE;
    const repoId = DEFAULT_31B_REPO;
    const snapshotDir = writeCachedAssets({
      hubCacheDir,
      repoId,
      snapshot: "snapshot-model-only",
      modelFile,
      includeMmproj: false,
    });
    const mmprojPath = join(llamaCacheDir, DEFAULT_MMPROJ_FILE);
    writeFileSync(mmprojPath, "mmproj");

    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      ctx: 16384,
      batch: 32,
      ubatch: 32,
      modelRepo: repoId,
      modelFile,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE,
      hfHubCacheDir: hubCacheDir,
      llamaCacheDir,
    });

    expect(args).toContain("-m");
    expect(args).toContain(join(snapshotDir, modelFile));
    expect(args).toContain("--mmproj");
    expect(args).toContain(mmprojPath);
    expect(args).not.toContain("--mmproj-url");
    expect(
      isModelCached({
        modelRepo: repoId,
        modelFile,
        mmprojRepo: DEFAULT_MMPROJ_REPO,
        mmprojFile: DEFAULT_MMPROJ_FILE,
        hfHubCacheDir: hubCacheDir,
        llamaCacheDir,
      }),
    ).toBe(true);
  });

  it("uses separate cached mmproj repo assets with cached HF model assets", () => {
    const hubCacheDir = createTempDir("hf-cache-");
    const modelFile = DEFAULT_31B_FILE;
    const repoId = DEFAULT_31B_REPO;
    const snapshotDir = writeCachedAssets({
      hubCacheDir,
      repoId,
      snapshot: "snapshot-model",
      modelFile,
      includeMmproj: false,
    });
    const mmprojSnapshotDir = writeCachedAssets({
      hubCacheDir,
      repoId: DEFAULT_MMPROJ_REPO,
      snapshot: "snapshot-mmproj",
      modelFile: DEFAULT_MMPROJ_FILE,
      includeMmproj: false,
    });

    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      ctx: 16384,
      batch: 32,
      ubatch: 32,
      modelRepo: repoId,
      modelFile,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE,
      hfHubCacheDir: hubCacheDir,
    });

    expect(args).toContain("-m");
    expect(args).toContain(join(snapshotDir, modelFile));
    expect(args).toContain("--mmproj");
    expect(args).toContain(join(mmprojSnapshotDir, DEFAULT_MMPROJ_FILE));
    expect(args).not.toContain("--mmproj-url");
    expect(
      isModelCached({
        modelRepo: repoId,
        modelFile,
        mmprojRepo: DEFAULT_MMPROJ_REPO,
        mmprojFile: DEFAULT_MMPROJ_FILE,
        hfHubCacheDir: hubCacheDir,
      }),
    ).toBe(true);
  });

  it("keeps generic custom HF repo launch when a custom mmproj is not configured", () => {
    const hubCacheDir = createTempDir("hf-cache-");
    const modelFile = "custom-q4.gguf";
    const repoId = "custom/gemma-vision";
    writeCachedAssets({
      hubCacheDir,
      repoId,
      snapshot: "snapshot-partial",
      modelFile,
      includeMmproj: false,
    });

    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      ctx: 16384,
      batch: 32,
      ubatch: 32,
      modelRepo: repoId,
      modelFile,
      hfHubCacheDir: hubCacheDir,
    });

    expect(args).toContain("-m");
    expect(args).not.toContain("--mmproj");
    expect(args).not.toContain("--mmproj-url");
    expect(
      isModelCached({
        modelRepo: repoId,
        modelFile,
        hfHubCacheDir: hubCacheDir,
      }),
    ).toBe(true);
  });

  it("detects cached assets from HF_HOME when HF_HUB_CACHE is unset", () => {
    const hfHomeDir = createTempDir("hf-home-");
    const previousHfHome = process.env.HF_HOME;
    const previousHubCache = process.env.HF_HUB_CACHE;
    const previousLegacyHubCache = process.env.HUGGINGFACE_HUB_CACHE;
    delete process.env.HF_HUB_CACHE;
    delete process.env.HUGGINGFACE_HUB_CACHE;
    process.env.HF_HOME = hfHomeDir;

    const modelFile = DEFAULT_31B_FILE;
    const repoId = DEFAULT_31B_REPO;
    writeCachedAssets({
      hubCacheDir: join(hfHomeDir, "hub"),
      repoId,
      snapshot: "snapshot-env",
      modelFile,
    });

    try {
      expect(isModelCached({ modelRepo: repoId, modelFile })).toBe(true);
    } finally {
      if (previousHfHome === undefined) {
        delete process.env.HF_HOME;
      } else {
        process.env.HF_HOME = previousHfHome;
      }
      if (previousHubCache === undefined) {
        delete process.env.HF_HUB_CACHE;
      } else {
        process.env.HF_HUB_CACHE = previousHubCache;
      }
      if (previousLegacyHubCache === undefined) {
        delete process.env.HUGGINGFACE_HUB_CACHE;
      } else {
        process.env.HUGGINGFACE_HUB_CACHE = previousLegacyHubCache;
      }
    }
  });
});
