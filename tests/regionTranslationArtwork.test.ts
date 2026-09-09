import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import {
  mergeRegionArtwork,
  prepareRegionArtwork,
} from "../src/main/jobs/regionTranslationArtwork";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { InpaintingEngine } from "../src/main/inpainting/inpaintingEngine";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { makeBlock, makePage } from "./unifiedInpaintingUiFixtures";
import { buildRegionTranslationRequest } from "../src/renderer/src/lib/regionTranslationOptions";

// Keep the real mask, engine dispatch, persistence and crop composition. Only
// Electron's native PNG adapter and the external model process are replaced.
vi.mock("electron", () => ({
  app: { isPackaged: false },
  nativeImage: {
    createFromPath: (path: string) =>
      nativePng(PNG.sync.read(readFileSync(path))),
    createFromBuffer: (bytes: Buffer) => nativePng(PNG.sync.read(bytes)),
    createFromBitmap: (
      bitmap: Buffer,
      size: { width: number; height: number },
    ) => {
      const image = new PNG(size);
      image.data = swapRedBlue(bitmap);
      return nativePng(image);
    },
  },
}));

function swapRedBlue(bytes: Buffer) {
  const result = Buffer.from(bytes);
  for (let offset = 0; offset < result.length; offset += 4) {
    result[offset] = bytes[offset + 2];
    result[offset + 2] = bytes[offset];
  }
  return result;
}

function nativePng(image: PNG) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width: image.width, height: image.height }),
    toBitmap: () => swapRedBlue(image.data),
    toPNG: () => PNG.sync.write(image),
    crop: (rect: { x: number; y: number; width: number; height: number }) => {
      const cropped = new PNG(rect);
      PNG.bitblt(image, cropped, rect.x, rect.y, rect.width, rect.height, 0, 0);
      return nativePng(cropped);
    },
  };
}

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});
function solid(w: number, h: number, value: number) {
  const image = new PNG({ width: w, height: h });
  image.data.fill(value);
  return image;
}
describe("region translation artwork commit", () => {
  it("changes only edited crop pixels and keeps prior background edits elsewhere", () => {
    const background = solid(6, 5, 90);
    const source = solid(2, 2, 200);
    const patch = solid(2, 2, 200);
    patch.data.set([1, 2, 3, 255], 12);
    mergeRegionArtwork(background, source, patch, { x: 2, y: 1, w: 2, h: 2 });
    for (let index = 0; index < 30; index++)
      expect([...background.data.subarray(index * 4, index * 4 + 4)]).toEqual(
        index === 15 ? [1, 2, 3, 255] : [90, 90, 90, 90],
      );
  });
  it("rejects a resized patch before modifying any background pixel", () => {
    const image = solid(6, 5, 90);
    const before = Buffer.from(image.data);
    expect(() =>
      mergeRegionArtwork(image, solid(2, 2, 1), solid(3, 2, 2), {
        x: 1,
        y: 1,
        w: 2,
        h: 2,
      }),
    ).toThrow("크기");
    expect(image.data).toEqual(before);
  });
  it("does no image decoding or engine setup when erasure is OFF", async () => {
    const page: MangaPage = {
      id: "p",
      name: "p",
      imagePath: "missing-source",
      dataUrl: "",
      width: 10,
      height: 10,
      blocks: [],
      analysisStatus: "idle",
      createdAt: "",
      updatedAt: "",
    };
    expect(
      await prepareRegionArtwork({
        source: page,
        crop: page,
        analyzed: page,
        rect: { x: 0, y: 0, w: 10, h: 10 },
        request: {
          chapterId: "c",
          pageId: "p",
          bbox: { x: 0, y: 0, w: 1000, h: 1000 },
          eraseOriginal: false,
        },
        directory: "missing-destination",
        decode: async () => {
          throw Error("must not decode");
        },
        signal: new AbortController().signal,
      }),
    ).toBeUndefined();
  });
});

describe("configured local region inpainting", () => {
  it.each(["flux-klein", "lama-manga", "aot-inpainting"] as const)(
    "%s receives surrounding page pixels and commits only the selected area",
    async (model) => {
      const fixture = await regionContextFixture(model);
      const output = await prepareRegionArtwork(
        fixture.input,
        fixture.dependencies,
      );
      expect(fixture.acquire).toHaveBeenCalledWith(
        expect.objectContaining({ model }),
      );
      expect(fixture.inpaint).toHaveBeenCalledOnce();
      const [bitmap, width, height, mask, windows] =
        fixture.inpaint.mock.calls[0];
      expect([width, height]).toEqual([200, 240]);
      expect(bitmap.length).toBe(200 * 240 * 4);
      expect(mask[0]).toBe(0);
      expect(mask[100 * width + 90]).toBeGreaterThan(0);
      expect(windows[0].w).toBeGreaterThan(fixture.input.rect.w);
      if (!output) throw new Error("Missing inpainted result");
      const result = PNG.sync.read(await readFile(output));
      let changed = 0;
      for (let y = 0; y < result.height; y++) {
        for (let x = 0; x < result.width; x++) {
          const offset = (y * result.width + x) * 4;
          const actual = result.data.subarray(offset, offset + 4);
          if (x < 80 || x >= 120 || y < 80 || y >= 160)
            expect(actual).toEqual(
              fixture.current.data.subarray(offset, offset + 4),
            );
          else if (
            !actual.equals(fixture.current.data.subarray(offset, offset + 4))
          )
            changed++;
        }
      }
      expect(changed).toBeGreaterThan(0);
      expect(fixture.release).toHaveBeenCalledOnce();
    },
  );

  it("reports unchanged targets instead of committing a successful background", async () => {
    const fixture = await regionContextFixture();
    fixture.inpaint.mockImplementation(async () => {});
    await expect(
      prepareRegionArtwork(fixture.input, fixture.dependencies),
    ).rejects.toThrow("일부 원문을 지우지 못했습니다");
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it.each([
    { x: 0, y: 0, w: 40, h: 80 },
    { x: 160, y: 160, w: 40, h: 80 },
    { x: 0, y: 0, w: 200, h: 240 },
  ])("handles edge and whole-page selections: %o", async (rect) => {
    const fixture = await regionContextFixture("flux-klein", rect);
    const output = await prepareRegionArtwork(
      fixture.input,
      fixture.dependencies,
    );
    if (!output) throw new Error("Missing inpainted result");
    const result = PNG.sync.read(await readFile(output));
    expect([result.width, result.height]).toEqual([200, 240]);
    const [, width, , mask] = fixture.inpaint.mock.calls[0];
    const center = (rect.y + rect.h / 2) * width + rect.x + rect.w / 2;
    expect(mask[center]).toBeGreaterThan(0);
    expect(result.data.subarray(center * 4, center * 4 + 4)).toEqual(
      Buffer.from([20, 60, 100, 255]),
    );
  });

  it("releases the engine after inference fails or is cancelled", async () => {
    const fixture = await regionContextFixture();
    const failure = new Error("inference cancelled");
    fixture.inpaint.mockRejectedValue(failure);
    await expect(
      prepareRegionArtwork(fixture.input, fixture.dependencies),
    ).rejects.toBe(failure);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("rejects changed source dimensions before acquiring a model", async () => {
    const fixture = await regionContextFixture();
    fixture.input.source.width = 201;
    await expect(
      prepareRegionArtwork(fixture.input, fixture.dependencies),
    ).rejects.toThrow("크기가 다릅니다");
    expect(fixture.acquire).not.toHaveBeenCalled();
  });

  it("continues to consume a crop-sized Codex result without running a local model", async () => {
    const fixture = await regionContextFixture();
    const request = buildRegionTranslationRequest(null, {
      output: "text",
      eraseOriginal: true,
      eraseEngine: "codex",
    });
    Object.assign(fixture.input.request, request);
    const generatedPath = join(fixture.input.directory, "codex-patch.png");
    const patch = solid(40, 80, 180);
    await writeFile(generatedPath, PNG.sync.write(patch));
    fixture.input.analyzed.inpaintedImagePath = generatedPath;
    const output = await prepareRegionArtwork(
      fixture.input,
      fixture.dependencies,
    );
    if (!output) throw new Error("Missing Codex result");
    const result = PNG.sync.read(await readFile(output));
    expect(
      result.data.subarray((100 * 200 + 90) * 4, (100 * 200 + 90) * 4 + 4),
    ).toEqual(Buffer.from([180, 180, 180, 180]));
    expect(fixture.acquire).not.toHaveBeenCalled();
  });
});

async function regionContextFixture(
  model: "flux-klein" | "lama-manga" | "aot-inpainting" = "flux-klein",
  rect = { x: 80, y: 80, w: 40, h: 80 },
) {
  const directory = await mkdtemp(join(tmpdir(), "region-context-test-"));
  roots.push(directory);
  vi.stubEnv("MANGA_TRANSLATOR_LOG_PATH", join(directory, "app.log"));
  const original = solid(200, 240, 255);
  for (let y = 92; y < 148; y++)
    for (let x = 88; x < 112; x++) {
      const offset = (y * original.width + x) * 4;
      original.data.set([20, 20, 20, 255], offset);
    }
  const sourcePath = join(directory, "source.png");
  const currentPath = join(directory, "previous.png");
  const cropPath = join(directory, "crop.png");
  const current = solid(200, 240, 220);
  await writeFile(sourcePath, PNG.sync.write(original));
  await writeFile(currentPath, PNG.sync.write(current));
  await writeFile(
    cropPath,
    nativePng(original)
      .crop({ x: rect.x, y: rect.y, width: rect.w, height: rect.h })
      .toPNG(),
  );
  const source = {
    ...makePage(),
    width: 200,
    height: 240,
    imagePath: sourcePath,
    inpaintedImagePath: currentPath,
  };
  const crop: MangaPage = {
    ...source,
    width: rect.w,
    height: rect.h,
    imagePath: cropPath,
    inpaintedImagePath: undefined,
    blocks: [],
  };
  const analyzed: MangaPage = {
    ...crop,
    blocks: [{ ...makeBlock(), bbox: { x: 100, y: 100, w: 800, h: 800 } }],
  };
  const inpaint = vi.fn<InpaintingEngine["inpaint"]>(
    async (bitmap, width, height, mask) => {
      for (let index = 0; index < width * height; index++)
        if (mask[index]) bitmap.set([100, 60, 20, 255], index * 4);
      bitmap.set([0, 0, 0, 255], 0); // An external engine must never affect outside the selection.
    },
  );
  const engine: InpaintingEngine = {
    model,
    backend: "fixture",
    runtimePath: "fixture",
    runRootDir: directory,
    inpaint,
    dispose: async () => {},
  };
  const release = vi.fn(async () => {});
  const acquire = vi.fn(async () => ({ engine, release }));
  const settings = resolveDefaultAppSettings();
  settings.inpainting = {
    ...settings.inpainting,
    model,
    fluxBackend: "cuda-native",
  };
  return {
    current,
    inpaint,
    acquire,
    release,
    dependencies: {
      getAppPaths: () =>
        ({}) as ReturnType<typeof import("../src/main/appPaths").getAppPaths>,
      getAppSettings: async () => settings,
      acquireInpaintingEngine: acquire,
    },
    input: {
      source,
      crop,
      analyzed,
      rect,
      directory,
      request: {
        chapterId: "c",
        pageId: source.id,
        bbox: { x: 400, y: 333, w: 200, h: 333 },
        ...buildRegionTranslationRequest(settings, {
          output: "text",
          eraseOriginal: true,
          eraseEngine: "default",
        }),
      },
      decode: async () => null,
      signal: new AbortController().signal,
    },
  };
}
