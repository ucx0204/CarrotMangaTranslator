import { describe, expect, it } from "vitest";
import { COMIC_BUBBLE_DETECTOR_URL } from "../src/main/bubbleLayout/assets";
import { associateComicDetections } from "../src/main/bubbleLayout/association";
import {
  COMIC_BUBBLE_DETECTOR_BYTES,
  COMIC_BUBBLE_DETECTOR_FILE,
  COMIC_BUBBLE_DETECTOR_REVISION,
  COMIC_BUBBLE_DETECTOR_SHA256,
} from "../src/main/bubbleLayout/constants";
import type { ComicPageDetection } from "../src/main/bubbleLayout/contracts";
import { parseComicDetectorOutputs } from "../src/main/bubbleLayout/outputs";
import { convertBgraBitmapToRgbChw } from "../src/main/bubbleLayout/preprocess";

describe("comic bubble RT-DETR core", () => {
  it("pins the verified Hugging Face model asset", () => {
    expect(COMIC_BUBBLE_DETECTOR_FILE).toBe("detector-v4-s_int8.onnx");
    expect(COMIC_BUBBLE_DETECTOR_REVISION).toBe(
      "16e8a622f91fabc6b5b65c96d32d1183f8843546",
    );
    expect(COMIC_BUBBLE_DETECTOR_SHA256).toBe(
      "5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79",
    );
    expect(COMIC_BUBBLE_DETECTOR_BYTES).toBe(11_120_765);
    expect(COMIC_BUBBLE_DETECTOR_URL).toContain(
      `/resolve/${COMIC_BUBBLE_DETECTOR_REVISION}/${COMIC_BUBBLE_DETECTOR_FILE}`,
    );
  });

  it("converts Electron BGRA pixels into rescaled RGB CHW planes", () => {
    const output = convertBgraBitmapToRgbChw(
      Uint8Array.of(10, 20, 30, 255, 40, 50, 60, 255),
      2,
      1,
    );

    const expected = [
      30 / 255,
      60 / 255,
      20 / 255,
      50 / 255,
      10 / 255,
      40 / 255,
    ];
    expected.forEach((value, index) => {
      expect(output[index]).toBeCloseTo(value);
    });
  });

  it("honors aborts during bitmap preprocessing", () => {
    const controller = new AbortController();
    controller.abort();

    expect(() =>
      convertBgraBitmapToRgbChw(new Uint8Array(4), 1, 1, controller.signal),
    ).toThrowError(expect.objectContaining({ name: "AbortError" }));
  });

  it("parses, clamps, filters, labels, and score-sorts ONNX outputs", () => {
    const detections = parseComicDetectorOutputs(
      {
        labels: {
          data: BigInt64Array.of(1n, 0n, 2n, 9n),
          dims: [1, 4],
        },
        boxes: {
          data: Float32Array.of(
            10,
            20,
            90,
            80,
            -5,
            5,
            120,
            70,
            20,
            30,
            40,
            50,
            0,
            0,
            10,
            10,
          ),
          dims: [1, 4, 4],
        },
        scores: {
          data: Float32Array.of(0.8, 0.95, 0.2, 0.99),
          dims: [1, 4],
        },
      },
      { width: 100, height: 90 },
      0.5,
    );

    expect(detections).toHaveLength(2);
    expect(detections[0]).toMatchObject({
      labelId: 0,
      label: "bubble",
      box: [0, 5, 100, 70],
    });
    expect(detections[1]).toMatchObject({
      labelId: 1,
      label: "text_bubble",
      box: [10, 20, 90, 80],
    });
    expect(detections[0].score).toBeCloseTo(0.95);
  });

  it("rejects malformed detector output tensors", () => {
    expect(() =>
      parseComicDetectorOutputs(
        {
          labels: { data: BigInt64Array.of(0n) },
          boxes: { data: Float32Array.of(0, 0, 10) },
          scores: { data: Float32Array.of(0.9) },
        },
        { width: 100, height: 100 },
      ),
    ).toThrow(/boxes/);
  });

  it("associates bubble text by containment and preserves free text", () => {
    const firstBubble = detection("bubble", 0, [0, 0, 100, 100], 0.9);
    const secondBubble = detection("bubble", 0, [100, 0, 200, 100], 0.8);
    const firstText = detection("text_bubble", 1, [20, 20, 80, 80], 0.95);
    const secondText = detection("text_bubble", 1, [120, 10, 180, 70], 0.85);
    const orphan = detection("text_bubble", 1, [220, 20, 260, 60], 0.7);
    const free = detection("text_free", 2, [10, 120, 80, 150], 0.75);

    const associated = associateComicDetections([
      firstBubble,
      secondBubble,
      firstText,
      secondText,
      orphan,
      free,
    ]);

    expect(associated.bubbles[0].textDetections).toEqual([firstText]);
    expect(associated.bubbles[1].textDetections).toEqual([secondText]);
    expect(associated.unassociatedBubbleText).toEqual([orphan]);
    expect(associated.freeText).toEqual([free]);
  });
});

function detection(
  label: ComicPageDetection["label"],
  labelId: ComicPageDetection["labelId"],
  box: ComicPageDetection["box"],
  score: number,
): ComicPageDetection {
  return { label, labelId, box, score };
}
