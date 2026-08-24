import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MangaPage } from "../src/shared/libraryTypes";

vi.mock("electron", () => ({
  nativeImage: {
    createFromPath: vi.fn(),
    createFromBuffer: vi.fn(),
  },
}));

import {
  buildMaskFromBitmapDifference,
  loadMaskArtifact,
  persistActualInpaintMask,
} from "../src/main/inpainting/inpaintMaskArtifact";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("inpaint mask artifact", () => {
  it("uses a conservative per-pixel difference threshold", () => {
    const original = Buffer.from([
      10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255,
    ]);
    const output = Buffer.from([
      12, 20, 30, 255, 13, 20, 30, 255, 10, 20, 30, 250,
    ]);
    expect([...buildMaskFromBitmapDifference(original, output, 3, 1)]).toEqual([
      0, 1, 1,
    ]);
  });

  it("writes and reloads an 8-bit full-page actual mask", async () => {
    const root = await makeTempDir();
    const page = makePage(join(root, "pages", "001.png"));
    const persisted = await persistActualInpaintMask({
      page,
      mask: Uint8Array.from([0, 1, 1, 0, 1, 0]),
      width: 3,
      height: 2,
      suffix: "actual",
    });
    expect(persisted.provenance).toBe("actual-mask");
    await expect(loadMaskArtifact(persisted.path, 3, 2)).resolves.toEqual(
      Uint8Array.from([0, 1, 1, 0, 1, 0]),
    );
  });

  it("rejects dimensions that do not match the pixel mask", async () => {
    const root = await makeTempDir();
    await expect(
      persistActualInpaintMask({
        page: makePage(join(root, "pages", "001.png")),
        mask: new Uint8Array(2),
        width: 2,
        height: 2,
        suffix: "bad",
      }),
    ).rejects.toThrow("크기");
  });
});

function makePage(imagePath: string): MangaPage {
  const timestamp = "2026-08-24T00:00:00.000Z";
  return {
    id: "page-1",
    name: "001.png",
    imagePath,
    dataUrl: "",
    width: 3,
    height: 2,
    blocks: [],
    analysisStatus: "completed",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function makeTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mgt-inpaint-mask-"));
  tempDirs.push(path);
  return path;
}
