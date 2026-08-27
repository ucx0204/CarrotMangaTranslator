import { describe, expect, it } from "vitest";
import {
  GEMMA_12B_QAT_MMPROJ_FILE,
  GEMMA_12B_QAT_MMPROJ_REPO,
  GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_12B_QAT_MODEL_REPO,
  GEMMA_12B_QAT_MTP_MODEL_FILE,
  GEMMA_12B_QAT_MTP_MODEL_REPO,
  GEMMA_26B_QAT_MMPROJ_FILE,
  GEMMA_26B_QAT_MMPROJ_REPO,
  GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_26B_QAT_MODEL_REPO,
  GEMMA_26B_QAT_MTP_MODEL_FILE,
  GEMMA_26B_QAT_MTP_MODEL_REPO,
  GEMMA_31B_QAT_MMPROJ_FILE,
  GEMMA_31B_QAT_MMPROJ_REPO,
  GEMMA_31B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_31B_QAT_MODEL_REPO,
  GEMMA_31B_QAT_MTP_MODEL_FILE,
  GEMMA_31B_QAT_MTP_MODEL_REPO,
} from "../src/shared/modelPresets";
import {
  collectRequiredHfDownloads,
  createTempDir,
} from "./helpers/runtimeModelContracts";

describe("QAT runtime asset launch contracts", () => {
  it("pins every QAT 12B model, vision, and MTP asset", () => {
    const tasks = collectRequiredHfDownloads({
      modelRepo: GEMMA_12B_QAT_MODEL_REPO,
      modelFile: GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
      mmprojRepo: GEMMA_12B_QAT_MMPROJ_REPO,
      mmprojFile: GEMMA_12B_QAT_MMPROJ_FILE,
      draftModelRepo: GEMMA_12B_QAT_MTP_MODEL_REPO,
      draftModelFile: GEMMA_12B_QAT_MTP_MODEL_FILE,
      draftSpecType: "draft-mtp",
      useDraft: true,
      hfHubCacheDir: createTempDir("hf-qat-12b-plan-"),
    });

    expect(tasks).toHaveLength(3);
    expect(
      tasks.map(({ kind, revision, expectedSha256 }) => ({
        kind,
        revision,
        expectedSha256,
      })),
    ).toEqual([
      {
        kind: "model",
        revision: "ae8045ac2bd216293ca49a3065da2c942dde4b68",
        expectedSha256:
          "59656d7494d6376ca97e9e20b64ea2e16cd97f12ec6d47bfccba91cb785b5134",
      },
      {
        kind: "mmproj",
        revision: "ae8045ac2bd216293ca49a3065da2c942dde4b68",
        expectedSha256:
          "b59e815479b7e5f0665bd29e6784c104a368092bcbc63120148c606f9276ab8e",
      },
      {
        kind: "draft",
        revision: "ae8045ac2bd216293ca49a3065da2c942dde4b68",
        expectedSha256:
          "c50c91c35f04903815b2e8930cbb8c8c5bee0e1aa00748c30a7b8ff05d2310b4",
      },
    ]);
  });

  it("pins every QAT 26B model, vision, and MTP asset", () => {
    const tasks = collectRequiredHfDownloads({
      modelRepo: GEMMA_26B_QAT_MODEL_REPO,
      modelFile: GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
      mmprojRepo: GEMMA_26B_QAT_MMPROJ_REPO,
      mmprojFile: GEMMA_26B_QAT_MMPROJ_FILE,
      draftModelRepo: GEMMA_26B_QAT_MTP_MODEL_REPO,
      draftModelFile: GEMMA_26B_QAT_MTP_MODEL_FILE,
      draftSpecType: "draft-mtp",
      useDraft: true,
      hfHubCacheDir: createTempDir("hf-qat-26b-plan-"),
    });

    expect(tasks).toHaveLength(3);
    expect(
      tasks.map(({ kind, revision, expectedSha256 }) => ({
        kind,
        revision,
        expectedSha256,
      })),
    ).toEqual([
      {
        kind: "model",
        revision: "f9093662a2e7ae0503f637088bc96f77a1a70c83",
        expectedSha256:
          "3c13133469e431312fffb8b1d9c85ae42199e6bb5746ea1da84e8ddf2097d73c",
      },
      {
        kind: "mmproj",
        revision: "f9093662a2e7ae0503f637088bc96f77a1a70c83",
        expectedSha256:
          "b5346e5bfd906f5e16878c2d0b8243e948ca7410fa28ea35be9b0c54a0ac10b7",
      },
      {
        kind: "draft",
        revision: "f9093662a2e7ae0503f637088bc96f77a1a70c83",
        expectedSha256:
          "62bd3af7f66c9308de9a5454233852f8c7324c93767e8dfb824ed45b9179864a",
      },
    ]);
  });

  it("pins every QAT 31B model, vision, and MTP asset", () => {
    const tasks = collectRequiredHfDownloads({
      modelRepo: GEMMA_31B_QAT_MODEL_REPO,
      modelFile: GEMMA_31B_QAT_MODEL_FILE_Q4_K_M,
      mmprojRepo: GEMMA_31B_QAT_MMPROJ_REPO,
      mmprojFile: GEMMA_31B_QAT_MMPROJ_FILE,
      draftModelRepo: GEMMA_31B_QAT_MTP_MODEL_REPO,
      draftModelFile: GEMMA_31B_QAT_MTP_MODEL_FILE,
      draftSpecType: "draft-mtp",
      useDraft: true,
      hfHubCacheDir: createTempDir("hf-qat-31b-plan-"),
    });

    expect(tasks).toHaveLength(3);
    expect(
      tasks.map(({ kind, revision, expectedSha256 }) => ({
        kind,
        revision,
        expectedSha256,
      })),
    ).toEqual([
      {
        kind: "model",
        revision: "9654466e82d83f5ebfe1518a369bc5900873abb1",
        expectedSha256:
          "71667f9e601a4b914a98425c59150b731f6e15d260d661dbd1f1ee07469fc7db",
      },
      {
        kind: "mmproj",
        revision: "9654466e82d83f5ebfe1518a369bc5900873abb1",
        expectedSha256:
          "7bef0d0fb3e85fc2941ec5f1c375febf3742645f158132a43ced557093aea841",
      },
      {
        kind: "draft",
        revision: "9654466e82d83f5ebfe1518a369bc5900873abb1",
        expectedSha256:
          "b5c4e583fc5982439080114bbc1b7edaec361f9d4c9193d6bed606a3de401b62",
      },
    ]);
  });
});
