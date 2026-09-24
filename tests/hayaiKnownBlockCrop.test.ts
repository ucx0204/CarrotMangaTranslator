import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { TranslationOptions } from "../src/main/appSettings";
import { prepareHayaiRegions } from "../src/main/textDetection/hayaiRegionPrepass";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const outputDir = await mkdtemp(join(tmpdir(), "hayai-known-crop-"));
  directories.push(outputDir);
  const options = {
    imagePath: join(outputDir, "source.png"),
    outputDir,
    workingDir: outputDir,
    imageWidth: 280,
    imageHeight: 42,
    ocrPipeline: "hayai",
    ocrInputKind: "known-block-crop",
  } as TranslationOptions;
  const detect = vi.fn<NonNullable<Parameters<typeof prepareHayaiRegions>[1]>>(
    async () => ({ imageWidth: 280, imageHeight: 42, detections: [] }),
  );
  return { options, detect };
}

it.each([
  [280, 42],
  [271, 36],
  [42, 280],
  [1, 1],
])(
  "sends the complete known %dx%d crop even when a page detector finds nothing",
  async (width, height) => {
    const { options, detect } = await fixture();
    const result = await prepareHayaiRegions(
      { ...options, imageWidth: width, imageHeight: height },
      detect,
    );
    expect(detect).not.toHaveBeenCalled();
    expect(result.manifest.dialogueRegions).toEqual([
      {
        id: 1,
        regionId: "known-block-1",
        kind: "dialogue",
        bbox: [0, 0, width, height],
        detectorConfidence: 0,
        sourceDetectionIds: [],
      },
    ]);
    expect(result.manifest.effectRegions).toEqual([]);
    expect(JSON.parse(await readFile(result.manifestPath, "utf8"))).toEqual(
      result.manifest,
    );
  },
);

it.each([undefined, "page"] as const)(
  "retains page detection for %s without a fabricated fallback region",
  async (ocrInputKind) => {
    const { options, detect } = await fixture();
    const result = await prepareHayaiRegions(
      { ...options, ocrInputKind },
      detect,
    );
    expect(detect).toHaveBeenCalledOnce();
    expect(detect).toHaveBeenCalledWith(
      expect.objectContaining({ imagePath: options.imagePath }),
    );
    expect(result.manifest.dialogueRegions).toEqual([]);
    expect(result.manifest.effectRegions).toEqual([]);
  },
);

it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, undefined])(
  "rejects invalid known-crop dimensions %s before detection or file creation",
  async (size) => {
    const { options, detect } = await fixture();
    for (const dimensions of [{ imageWidth: size }, { imageHeight: size }]) {
      await expect(
        prepareHayaiRegions({ ...options, ...dimensions }, detect),
      ).rejects.toThrow("exact positive image dimensions");
    }
    expect(detect).not.toHaveBeenCalled();
    await expect(
      readFile(join(options.outputDir, "hayai-regions.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("rejects cancellation and the wrong engine without preparing a region", async () => {
  const { options, detect } = await fixture();
  await expect(
    prepareHayaiRegions(
      { ...options, abortSignal: AbortSignal.abort() },
      detect,
    ),
  ).rejects.toThrow();
  await expect(
    prepareHayaiRegions({ ...options, ocrPipeline: "paddle-legacy" }, detect),
  ).rejects.toThrow();
  expect(detect).not.toHaveBeenCalled();
  await expect(
    readFile(join(options.outputDir, "hayai-regions.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
