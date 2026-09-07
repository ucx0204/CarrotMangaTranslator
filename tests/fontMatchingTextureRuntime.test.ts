import { describe, expect, it } from "vitest";
import fixture from "./fixtures/fontTextureParity.json";
import textureArtifact from "../src/main/pipeline/fontTextureModel.json";
import { prepareFontTextureSupport } from "../src/main/pipeline/fontMatchingTextureSupport";
import {
  inferFontTexturePage,
  loadFontTextureModel,
} from "../src/main/pipeline/fontMatchingTextureRuntime";
import { makePixelWinnerInference } from "./helpers/automaticFontMatchingV2Fixtures";
import { makePage } from "./helpers/automaticFontMatchingV2Fixtures";
import { createDefaultFontPaletteInferencePort } from "../src/main/pipeline/fontMatchingPaletteFallback";
import type {
  FontMatchingPageInferenceBlock,
  VerifiedAutomaticFontPixelInferenceV2,
} from "../src/main/pipeline/fontMatchingPagePixelInferenceTypes";
import {
  onnxRuntimeNode as ort,
  runDisposableFloatTensorStage,
} from "../src/main/runtimeSupport/nativeOnnxRuntime";
const bbox = { x: 0, y: 0, w: 1000, h: 1000 };
function raster(row: (typeof fixture.cases)[number]) {
  const rgb = Buffer.from(row.rgbBase64, "base64"),
    bgra = new Uint8Array(row.width * row.height * 4);
  for (let i = 0; i < row.width * row.height; i++) {
    bgra[i * 4] = rgb[i * 3 + 2];
    bgra[i * 4 + 1] = rgb[i * 3 + 1];
    bgra[i * 4 + 2] = rgb[i * 3];
    bgra[i * 4 + 3] = 255;
  }
  return { width: row.width, height: row.height, bgra };
}
describe("frozen intact-texture native parity", () => {
  it("rejects a mismatched artifact inventory before opening the native session", async () => {
    const originalByteSize = textureArtifact.byteSize;
    try {
      textureArtifact.byteSize = originalByteSize + 1;
      await expect(loadFontTextureModel()).rejects.toThrow(
        "Source font texture model integrity check failed.",
      );
    } finally {
      textureArtifact.byteSize = originalByteSize;
    }
  });
  it("does not reopen palette resources after disposal and allows repeated disposal", async () => {
    let selectionReads = 0;
    const unused = "font-texture-disposed-port-not-loaded";
    const port = createDefaultFontPaletteInferencePort({
      paths: {
        isPackaged: false,
        repoRoot: unused,
        executableDir: unused,
        resourcesDir: unused,
        dataRoot: unused,
        settingsPath: unused,
        libraryDir: unused,
        fontsDir: unused,
        logsDir: unused,
        logFile: unused,
        runtimeDir: unused,
        toolsDir: unused,
        ocrRuntimeDir: unused,
        llamaRuntimeDir: unused,
        llamaServerPath: unused,
      },
      loadSelection: () => {
        selectionReads++;
        return {
          candidates: [],
          renderCandidates: [],
          installedCandidates: [],
          activeCatalog: {
            catalogVersion: "empty",
            locale: "ko",
            candidateIds: [],
            candidateOrderSha256: "",
            candidates: [],
            excludedCandidates: [],
            recordSha256: "",
            sourceRecords: {
              catalogDispositionRecordSha256: "",
              deploymentFontFaceManifestSha256: "",
              deploymentRenderBankManifestSha256: "",
              evidenceFontFaceManifestSha256: "",
              evidenceRenderBankManifestSha256: "",
              finalCatalogRecordSha256: "",
            },
          },
        };
      },
    });
    // The base port's non-Korean abstention must not load Korean native models.
    const empty = await port.inferPage({
      page: makePage(),
      blocks: [],
      candidates: [],
      targetLanguage: "en",
      boundary: { source: "user_page", datasetSplit: null, qaOverlay: false },
    });
    expect(empty.pixelInferenceByBlockId.size).toBe(0);
    expect(selectionReads).toBe(1);
    await port.dispose?.();
    await port.dispose?.();
    await expect(
      port.inferPage({
        page: makePage(),
        blocks: [],
        candidates: [],
        boundary: { source: "user_page", datasetSplit: null, qaOverlay: false },
      }),
    ).rejects.toThrow("disposed");
    expect(selectionReads).toBe(1);
  });
  it("attaches native page evidence without altering proxy rows, and abstains or cancels at the page boundary", async () => {
    const block: FontMatchingPageInferenceBlock = {
      blockId: "texture",
      item: {
        id: 1,
        type: "nonsolid",
        direction: "horizontal",
        bbox,
        jp: "台詞",
        ko: "대사",
      },
    };
    const original: VerifiedAutomaticFontPixelInferenceV2 = {
      ...makePixelWinnerInference("nanum-myeongjo", block.blockId),
      crossScriptProxy: {
        kind: "verified_cross_script_proxy",
        contractVersion: "font-matching-cross-script-proxy-inference-v2",
        modelVersion: "manga-font-crossscript-proxy-runtime-v2",
        voice: 1,
        voiceCount: 1,
        candidates: [],
      },
    };
    const rows = new Map([[block.blockId, original]]);
    const session = await loadFontTextureModel();
    try {
      const options = {
        session,
        blocks: [block],
        rows,
        raster: raster(fixture.cases[0]),
      };
      const output = await inferFontTexturePage(options);
      expect(output.get(block.blockId)?.sourceTexture).toMatchObject({
        modelSha256: fixture.modelSha256,
        patchCount: fixture.cases[0].count,
      });
      expect(
        output
          .get(block.blockId)
          ?.sourceTexture?.probabilities.reduce((a, b) => a + b, 0),
      ).toBeCloseTo(1, 10);
      expect(
        output
          .get(block.blockId)
          ?.sourceTexture?.weightProbabilities.reduce((a, b) => a + b, 0),
      ).toBeCloseTo(1, 10);
      expect(output.get(block.blockId)?.crossScriptProxy).toBe(
        original.crossScriptProxy,
      );
      expect(rows.get(block.blockId)?.sourceTexture).toBeUndefined();
      const noProxy = { ...original, crossScriptProxy: undefined };
      const independent = await inferFontTexturePage({
        ...options,
        rows: new Map([[block.blockId, noProxy]]),
      });
      expect(independent.get(block.blockId)?.sourceTexture).toEqual(
        output.get(block.blockId)?.sourceTexture,
      );
      expect(independent.get(block.blockId)?.crossScriptProxy).toBeUndefined();
      expect(
        (await inferFontTexturePage({ ...options, rows: new Map() })).size,
      ).toBe(0);
      options.raster.bgra.fill(255);
      expect((await inferFontTexturePage(options)).get(block.blockId)).toBe(
        original,
      );
      await expect(
        inferFontTexturePage({ ...options, signal: AbortSignal.abort() }),
      ).rejects.toThrow();
    } finally {
      await session.release();
    }
  });
  for (const row of fixture.cases)
    it(`matches PIL/OpenCV source patches: ${row.name}`, () => {
      const support = prepareFontTextureSupport(raster(row), bbox);
      if (!support) throw new Error("Missing fixture texture support");
      expect(support.count).toBe(row.count);
      const expected = Buffer.from(row.patchUint8Base64, "base64");
      const actual = Buffer.from(
        support.values.map((v) => Math.round(v * 255)),
      );
      expect([...actual].filter((v, i) => v !== expected[i]).length).toBe(0);
    });
  it("abstains on empty pixels and honors cancellation", () => {
    const page = raster(fixture.cases[0]);
    page.bgra.fill(255);
    expect(prepareFontTextureSupport(page, bbox)).toBeNull();
    expect(() =>
      prepareFontTextureSupport(page, bbox, AbortSignal.abort()),
    ).toThrow();
  });
  it("runs exact CPU model through native gateway and matches Python logits", async () => {
    const session = await loadFontTextureModel();
    try {
      for (const row of fixture.cases) {
        const support = prepareFontTextureSupport(raster(row), bbox);
        if (!support) throw new Error("Missing fixture texture support");
        const actual = await runDisposableFloatTensorStage({
          session,
          inputName: "ink",
          outputName: "logits",
          input: new ort.Tensor("float32", support.values, [
            support.count,
            1,
            96,
            96,
          ]),
          expectedDimensions: [support.count, 15],
          consume: (v) => Array.from(v),
        });
        expect(
          Math.max(...actual.map((v, i) => Math.abs(v - row.logits.flat()[i]))),
        ).toBeLessThan(0.00005);
      }
    } finally {
      await session.release();
    }
  });
});
