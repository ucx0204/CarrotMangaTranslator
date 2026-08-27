import { describe, expect, it } from "vitest";
import {
  GEMMA_12B_QAT_MTP_MODEL_FILE,
  GEMMA_12B_QAT_MTP_MODEL_REPO,
} from "../src/shared/modelPresets";
import {
  DEFAULT_26B_FILE,
  DEFAULT_26B_MMPROJ_FILE,
  DEFAULT_26B_MMPROJ_REPO,
  DEFAULT_26B_REPO,
  buildLaunchArgs,
  createTempDir,
} from "./helpers/runtimeModelContracts";

describe("runtime launch memory policy", () => {
  it("disables mmap when a high fit reserve moves MoE tensors to CPU", () => {
    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 9216,
      ctx: 16384,
      batch: 2048,
      ubatch: 1536,
      gpuLayers: "fit",
      mmprojOffload: true,
      modelRepo: DEFAULT_26B_REPO,
      modelFile: DEFAULT_26B_FILE,
      mmprojRepo: DEFAULT_26B_MMPROJ_REPO,
      mmprojFile: DEFAULT_26B_MMPROJ_FILE,
      disableMmap: true,
      useDraft: true,
      draftSpecType: "draft-mtp",
      draftModelRepo: GEMMA_12B_QAT_MTP_MODEL_REPO,
      draftModelFile: GEMMA_12B_QAT_MTP_MODEL_FILE,
      hfHubCacheDir: createTempDir("high-fit-mtp-cache-"),
    });

    expect(args).toContain("--no-mmap");
  });

  it("keeps mmap enabled for non-MTP high-fit launches", () => {
    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 9216,
      ctx: 16384,
      batch: 2048,
      ubatch: 1536,
      gpuLayers: "fit",
      mmprojOffload: true,
      modelRepo: DEFAULT_26B_REPO,
      modelFile: DEFAULT_26B_FILE,
      mmprojRepo: DEFAULT_26B_MMPROJ_REPO,
      mmprojFile: DEFAULT_26B_MMPROJ_FILE,
      disableMmap: false,
    });

    expect(args).not.toContain("--no-mmap");
  });
});
