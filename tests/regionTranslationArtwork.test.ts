import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import {
  mergeRegionArtwork,
  prepareRegionArtwork,
} from "../src/main/jobs/regionTranslationArtwork";
import type { MangaPage } from "../src/shared/libraryTypes";
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
