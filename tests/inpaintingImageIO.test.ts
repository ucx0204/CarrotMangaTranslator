import { mkdtemp, writeFile, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { nativeImage } from "electron";
import {
  loadPageImage,
  loadPageImageSnapshot,
} from "../src/main/inpainting/imageIO";
import { basename, dirname, join, win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  nativeImage: {
    createFromBuffer: vi.fn(),
    createFromPath: vi.fn(),
  },
}));

import { resolveInpaintedImagePath } from "../src/main/inpainting/imageIO";

const WORK_ID = "11111111-1111-4111-8111-111111111111";
const CHAPTER_ID = "22222222-2222-4222-8222-222222222222";

describe("resolveInpaintedImagePath", () => {
  it("creates a fresh immutable output path for every inpainting result", () => {
    const rootDir = "virtual-library";
    const source = join(
      rootDir,
      "works",
      WORK_ID,
      "chapters",
      CHAPTER_ID,
      "pages",
      "001-page-a.png",
    );

    const first = resolveInpaintedImagePath(source, "pattern");
    const second = resolveInpaintedImagePath(source, "pattern");
    expect(first).not.toBe(second);
    expect(first).toMatch(/[\\/]inpainted[\\/]pattern-[0-9a-f-]{36}\.png$/i);
    expect(second).toMatch(/[\\/]inpainted[\\/]pattern-[0-9a-f-]{36}\.png$/i);
    expect(basename(first).length).toBeLessThanOrEqual(57);
  });

  it("keeps generated artifact names bounded regardless of the source name", () => {
    const rootDir = "virtual-library";
    const source = join(
      rootDir,
      "works",
      WORK_ID,
      "chapters",
      CHAPTER_ID,
      "pages",
      `${"source-name-".repeat(18)}.png`,
    );

    const output = resolveInpaintedImagePath(
      source,
      `suffix-${"x".repeat(100)}`,
    );

    expect(dirname(output)).toBe(
      join(rootDir, "works", WORK_ID, "chapters", CHAPTER_ID, "inpainted"),
    );
    expect(basename(output).length).toBeLessThanOrEqual(57);
    expect(basename(output)).not.toContain("source-name");
  });

  it("keeps the reported installed result path safely below MAX_PATH", () => {
    const reportedLibraryRoot =
      "C:\\Users\\USER\\AppData\\Local\\Programs\\carrot-manga-translator\\data\\library";
    const reportedLegacyPath = win32.join(
      reportedLibraryRoot,
      "works",
      "ac7d39e9-cdb8-459f-a6bb-3dea736b0567",
      "chapters",
      "11b7563c-d12f-4e29-bc10-74179c992472",
      "inpainted",
      "001-2019aaa2-d470-4a7a-8de0-249087e7948a-pattern-48b791ce-6855-426b-89f6-bcc664215890.png",
    );
    const output = resolveInpaintedImagePath(
      join("virtual-library", "pages", "source.png"),
      "x".repeat(100),
    );
    const reportedNewPath = win32.join(
      win32.dirname(reportedLegacyPath),
      basename(output),
    );

    expect(reportedLegacyPath.length).toBe(262);
    expect(reportedNewPath.length).toBeLessThan(252);
  });
});

it("loads file bytes when native path decoding fails and reports an undecodable image", async () => {
  const root = await mkdtemp(join(tmpdir(), "inpainting-decode-"));
  try {
    const file = join(root, "source.jpg");
    await writeFile(file, Buffer.from("fixture"));
    vi.mocked(nativeImage.createFromPath).mockReturnValue({
      isEmpty: () => true,
    } as Electron.NativeImage);
    const decoded = { isEmpty: () => false } as Electron.NativeImage;
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue(decoded);
    expect(await loadPageImage(file)).toBe(decoded);
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue({
      isEmpty: () => true,
    } as Electron.NativeImage);
    await expect(loadPageImage(file)).rejects.toThrow("읽지 못했습니다");
    vi.mocked(nativeImage.createFromBuffer)
      .mockReturnValueOnce({ isEmpty: () => true } as Electron.NativeImage)
      .mockReturnValueOnce(decoded);
    expect(await loadPageImage(file, async () => Buffer.from("decoded"))).toBe(
      decoded,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "uses frozen fallback bytes and cleans temporary snapshots (%s)",
  async (fail) => {
    const root = await mkdtemp(join(tmpdir(), "frozen-image-"));
    let frozenPath = "";
    try {
      const source = join(root, "source.jpg");
      await writeFile(source, "replacement");
      const decoded = { isEmpty: () => false } as Electron.NativeImage;
      vi.mocked(nativeImage.createFromBuffer)
        .mockReset()
        .mockReturnValueOnce({ isEmpty: () => true } as Electron.NativeImage)
        .mockReturnValueOnce({ isEmpty: () => true } as Electron.NativeImage)
        .mockReturnValue(decoded);
      vi.mocked(nativeImage.createFromPath).mockReturnValue({
        isEmpty: () => true,
      } as Electron.NativeImage);
      const fallback = async (path: string) => {
        frozenPath = path;
        expect(path).not.toBe(source);
        expect(path.endsWith(".jpg")).toBe(true);
        expect((await readFile(path)).toString()).toBe("approved");
        if (fail) throw Error("decoder failed");
        return Buffer.from("decoded");
      };
      const operation = loadPageImageSnapshot(
        source,
        Buffer.from("approved"),
        fallback,
      );
      if (fail) await expect(operation).rejects.toThrow("decoder failed");
      else expect(await operation).toBe(decoded);
      expect(frozenPath).not.toBe("");
      await expect(access(frozenPath)).rejects.toThrow();
      expect((await readFile(source)).toString()).toBe("replacement");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
