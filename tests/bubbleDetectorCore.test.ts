import { describe, expect, it } from "vitest";
import { KOHARU_LAYOUT_ONNX_URL } from "../src/main/bubbleLayout/assets";
import { associateComicDetections } from "../src/main/bubbleLayout/association";
import {
  KOHARU_LAYOUT_INPUT_SIZE,
  KOHARU_LAYOUT_MASK_SIZE,
  KOHARU_LAYOUT_ONNX_BYTES,
  KOHARU_LAYOUT_ONNX_FILE,
  KOHARU_LAYOUT_ONNX_REVISION,
  KOHARU_LAYOUT_ONNX_SHA256,
  KOHARU_LAYOUT_QUERY_COUNT,
} from "../src/main/bubbleLayout/constants";
import type { ComicPageDetection } from "../src/main/bubbleLayout/contracts";
import { parseKoharuLayoutOutputs } from "../src/main/bubbleLayout/outputs";
import { convertBgraBitmapToRgbChw } from "../src/main/bubbleLayout/preprocess";

describe("KoharuLayout detector core", () => {
  it("pins the validated KoharuLayout ONNX asset", () => {
    expect(KOHARU_LAYOUT_ONNX_FILE).toBe("rfdetr-seg-2xlarge.onnx");
    expect(KOHARU_LAYOUT_ONNX_REVISION).toBe(
      "bfbbd4e5ab34a50459865074fa044da496cebb57",
    );
    expect(KOHARU_LAYOUT_ONNX_SHA256).toBe(
      "7cc10d4316371946b8441da3512261a8e148b129abcdb0ea6235ed1d1d06d351",
    );
    expect(KOHARU_LAYOUT_ONNX_BYTES).toBe(148_442_003);
    expect(KOHARU_LAYOUT_INPUT_SIZE).toBe(1152);
    expect(KOHARU_LAYOUT_ONNX_URL).toContain(
      `/resolve/${KOHARU_LAYOUT_ONNX_REVISION}/${KOHARU_LAYOUT_ONNX_FILE}`,
    );
  });

  it("converts Electron BGRA pixels into ImageNet-normalized RGB CHW", () => {
    const output = convertBgraBitmapToRgbChw(
      Uint8Array.of(10, 20, 30, 255, 40, 50, 60, 255),
      2,
      1,
    );
    const rgb = [30 / 255, 60 / 255, 20 / 255, 50 / 255, 10 / 255, 40 / 255];
    const mean = [0.485, 0.485, 0.456, 0.456, 0.406, 0.406];
    const std = [0.229, 0.229, 0.224, 0.224, 0.225, 0.225];
    rgb.forEach((value, index) => {
      expect(output[index]).toBeCloseTo(
        (value - (mean[index] ?? 0)) / (std[index] ?? 1),
      );
    });
  });

  it("honors aborts during bitmap preprocessing", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      convertBgraBitmapToRgbChw(new Uint8Array(4), 1, 1, controller.signal),
    ).toThrowError(expect.objectContaining({ name: "AbortError" }));
  });

  it("sigmoids class logits, applies class thresholds, converts boxes, and copies masks", () => {
    const outputs = buildOutputs([
      { query: 0, labelId: 2, probability: 0.9, box: [0.5, 0.5, 0.6, 0.4] },
      { query: 1, labelId: 0, probability: 0.7, box: [0.2, 0.3, 0.2, 0.2] },
      { query: 2, labelId: 1, probability: 0.19, box: [0.8, 0.8, 0.1, 0.1] },
    ]);
    const detections = parseKoharuLayoutOutputs(outputs, {
      width: 100,
      height: 200,
    });

    expect(detections).toHaveLength(2);
    expect(detections[0]).toMatchObject({ labelId: 2, label: "bubble" });
    expect(detections[1]).toMatchObject({ labelId: 0, label: "text" });
    [20, 60, 80, 140].forEach((value, index) =>
      expect(detections[0]?.box[index]).toBeCloseTo(value),
    );
    [10, 40, 30, 80].forEach((value, index) =>
      expect(detections[1]?.box[index]).toBeCloseTo(value),
    );
    expect(detections[0]?.mask).toMatchObject({
      width: KOHARU_LAYOUT_MASK_SIZE,
      height: KOHARU_LAYOUT_MASK_SIZE,
    });
    expect(detections[0]?.mask?.logits[0]).toBe(1);
  });

  it("rejects malformed graph output shapes", () => {
    const outputs = buildOutputs([]);
    outputs.dets = { data: new Float32Array(4), dims: [1, 1, 4] };
    expect(() =>
      parseKoharuLayoutOutputs(outputs, { width: 100, height: 100 }),
    ).toThrow(/dets.*shape/);
  });

  it("drops detections with invalid boxes and rejects invalid source sizes", () => {
    const outputs = buildOutputs([
      { query: 0, labelId: 2, probability: 0.9, box: [0.5, 0.5, 0, 0.4] },
    ]);

    expect(
      parseKoharuLayoutOutputs(outputs, { width: 100, height: 100 }),
    ).toEqual([]);
    expect(() =>
      parseKoharuLayoutOutputs(outputs, { width: 0, height: 100 }),
    ).toThrow(/이미지 크기/);
  });

  it("associates Koharu text with bubbles and preserves text/SFX outside bubbles", () => {
    const firstBubble = detection("bubble", 2, [0, 0, 100, 100], 0.9);
    const secondBubble = detection("bubble", 2, [100, 0, 200, 100], 0.8);
    const firstText = detection("text", 0, [20, 20, 80, 80], 0.95);
    const secondText = detection("text", 0, [120, 10, 180, 70], 0.85);
    const orphan = detection("text", 0, [220, 20, 260, 60], 0.7);
    const sound = detection("onomatopoeia", 1, [10, 120, 80, 150], 0.75);
    const associated = associateComicDetections([
      firstBubble,
      secondBubble,
      firstText,
      secondText,
      orphan,
      sound,
    ]);
    expect(associated.bubbles[0]?.textDetections).toEqual([firstText]);
    expect(associated.bubbles[1]?.textDetections).toEqual([secondText]);
    expect(associated.unassociatedBubbleText).toEqual([orphan]);
    expect(associated.freeText).toEqual([sound, orphan]);
  });
});

function buildOutputs(
  entries: {
    query: number;
    labelId: 0 | 1 | 2 | 3;
    probability: number;
    box: [number, number, number, number];
  }[],
): Record<string, { data: ArrayLike<number>; dims: number[] }> {
  const dets = new Float32Array(KOHARU_LAYOUT_QUERY_COUNT * 4);
  const labels = new Float32Array(KOHARU_LAYOUT_QUERY_COUNT * 5).fill(-20);
  for (const entry of entries) {
    dets.set(entry.box, entry.query * 4);
    labels[entry.query * 5 + entry.labelId] = logit(entry.probability);
  }
  const planeSize = KOHARU_LAYOUT_MASK_SIZE ** 2;
  return {
    dets: { data: dets, dims: [1, KOHARU_LAYOUT_QUERY_COUNT, 4] },
    labels: { data: labels, dims: [1, KOHARU_LAYOUT_QUERY_COUNT, 5] },
    masks: {
      data: virtualArray(KOHARU_LAYOUT_QUERY_COUNT * planeSize, 1),
      dims: [
        1,
        KOHARU_LAYOUT_QUERY_COUNT,
        KOHARU_LAYOUT_MASK_SIZE,
        KOHARU_LAYOUT_MASK_SIZE,
      ],
    },
  };
}

function virtualArray(length: number, value: number): ArrayLike<number> {
  return new Proxy({ length } as ArrayLike<number>, {
    get(target, property) {
      if (property === "length") return target.length;
      return typeof property === "string" && /^\d+$/.test(property)
        ? value
        : Reflect.get(target, property);
    },
  });
}

function logit(probability: number): number {
  return Math.log(probability / (1 - probability));
}

function detection(
  label: ComicPageDetection["label"],
  labelId: ComicPageDetection["labelId"],
  box: ComicPageDetection["box"],
  score: number,
): ComicPageDetection {
  return { label, labelId, box, score };
}
