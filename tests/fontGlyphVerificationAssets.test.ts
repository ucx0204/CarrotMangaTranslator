import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareFontGlyphVerificationAssets } from "../src/main/pipeline/fontGlyphVerificationAssets";

const download = vi.hoisted(() => vi.fn());
vi.mock("../src/main/runtimeSupport/modelDownloads", async (original) => ({
  ...(await original<
    typeof import("../src/main/runtimeSupport/modelDownloads")
  >()),
  ensureRemoteFile: download,
}));
beforeEach(() => {
  download.mockReset();
});
describe("managed glyph accelerator", () => {
  it("pins both weights and dictionary and forwards download progress", async () => {
    const signal = new AbortController().signal;
    const onProgress = vi.fn();
    const directory = await prepareFontGlyphVerificationAssets({
      dataRoot: "data",
      signal,
      onProgress,
    });
    expect(directory).toContain("font-glyph-ppocr-v02-r2");
    expect(download).toHaveBeenCalledTimes(2);
    expect(
      download.mock.calls.map(([task]) => [
        task.fileName,
        task.expectedTotalBytes,
        task.expectedSha256,
      ]),
    ).toEqual([
      [
        "manga_rec_v0.2.onnx",
        21167540,
        "de12c84c63e62c80339e882e675983d886670dcb6f0147e1ed041afd6fa81888",
      ],
      [
        "ppocrv6_dict.txt",
        74947,
        "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d",
      ],
    ]);
    for (const [task] of download.mock.calls) {
      expect(task).toMatchObject({
        signal,
        onProgress,
        progressPhase: "font_matching_downloading",
      });
      expect(task.url).toBe(
        `https://github.com/ucx0204/CarrotMangaTranslator/releases/download/font-glyph-ppocr-v02-20261116-r1/${task.fileName}`,
      );
      expect(task.expectedSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(task.minimumBytes).toBe(task.maximumBytes);
    }
  });
  it("retains ordinary Hayai when optional assets cannot be installed", async () => {
    download.mockRejectedValue(new Error("offline"));
    await expect(
      prepareFontGlyphVerificationAssets({
        dataRoot: "data",
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();
  });
  it("propagates cancellation instead of proceeding with Hayai", async () => {
    const controller = new AbortController();
    download.mockImplementation(() => {
      controller.abort();
      throw new Error("download stopped");
    });
    await expect(
      prepareFontGlyphVerificationAssets({
        dataRoot: "data",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
