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
    expect(KOHARU_LAYOUT_ONNX_FILE).toBe("model.onnx");
    expect(KOHARU_LAYOUT_ONNX_REVISION).toBe(
      "a5818861f184f496c2e45063c9542ffb7abccd37",
    );
    expect(KOHARU_LAYOUT_ONNX_SHA256).toBe(
      "b2f8807dfd00adc82233f4456e79a32fdc32d658ddb2a7a0182c523c638e52ea",
    );
    expect(KOHARU_LAYOUT_ONNX_BYTES).toBe(174_648_069);
    expect(KOHARU_LAYOUT_INPUT_SIZE).toBe(1920);
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

  it("maps sparse mask planes back to the original detector queries", () => {
    const size = KOHARU_LAYOUT_MASK_SIZE;
    const outputs = buildOutputs([
      { query: 17, labelId: 2, probability: 0.98, box: [0.5, 0.5, 0.6, 0.6] },
    ]);
    const view = { width: 100, height: 100 };
    const expected = parseKoharuLayoutOutputs(outputs, view);
    const sparse = {
      ...outputs,
      masks: {
        dims: [1, 2, size, size],
        data: new Float32Array(2 * size * size).fill(1, size * size),
      },
      queries: { dims: [2], data: Int32Array.from([9, 17]) },
    };
    const actual = parseKoharuLayoutOutputs(sparse, view);
    expect(actual[0]?.box).toEqual(expected[0]?.box);
    expect(actual[0]?.mask?.logits).toEqual(expected[0]?.mask?.logits);
    expect(() =>
      parseKoharuLayoutOutputs(
        { ...sparse, queries: { dims: [2], data: [9, 10] } },
        view,
      ),
    ).toThrow(/missing/);
    expect(() =>
      parseKoharuLayoutOutputs(
        { ...sparse, queries: { dims: [2], data: [9, 9] } },
        view,
      ),
    ).toThrow(/index/);
    const empty = {
      ...buildOutputs([]),
      masks: { dims: [1, 0, size, size], data: new Float32Array() },
      queries: { dims: [0], data: [] },
    };
    expect(parseKoharuLayoutOutputs(empty, view)).toEqual([]);
  });

  it("honors aborts during bitmap preprocessing", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      convertBgraBitmapToRgbChw(new Uint8Array(4), 1, 1, controller.signal),
    ).toThrowError(expect.objectContaining({ name: "AbortError" }));
  });

  it.each([
    { width: 3, height: 2, padding: 15 },
    { width: 2, height: 3, padding: 3 },
  ])(
    "letterboxes $width × $height at the top left on white",
    ({ width, height, padding }) => {
      const bitmap = new Uint8Array(width * height * 4);
      const chw = convertBgraBitmapToRgbChw(
        bitmap,
        width,
        height,
        undefined,
        4,
      );
      expect(chw).toHaveLength(48);
      expect(chw[0]).toBeCloseTo(-0.485 / 0.229);
      expect(chw[padding]).toBeCloseTo((1 - 0.485) / 0.229);
      expect(chw[32 + padding]).toBeCloseTo((1 - 0.406) / 0.225);
    },
  );

  it("keeps text on an ambiguous query and suppresses its nested duplicate", () => {
    const outputs = buildOutputs([
      { query: 0, labelId: 1, probability: 0.95, box: [0.3, 0.4, 0.2, 0.3] },
      { query: 0, labelId: 0, probability: 0.8, box: [0.3, 0.4, 0.2, 0.3] },
      { query: 1, labelId: 0, probability: 0.7, box: [0.3, 0.4, 0.06, 0.1] },
      { query: 2, labelId: 1, probability: 0.35, box: [0.2, 0.3, 0.1, 0.1] },
      { query: 3, labelId: 2, probability: 0.45, box: [0.3, 0.4, 0.3, 0.4] },
    ]);
    expect(
      parseKoharuLayoutOutputs(outputs, { width: 120, height: 70 }).map(
        (d) => d.label,
      ),
    ).toEqual(["text", "bubble"]);
  });

  it("ranks the background slots before limiting the 160 query/class pairs", () => {
    const outputs = buildOutputs([
      { query: 200, labelId: 0, probability: 0.9, box: [0.5, 0.5, 0.2, 0.2] },
    ]);
    const logits = outputs.labels.data as Float32Array;
    for (let query = 0; query < 160; query++) logits[query * 5 + 4] = 10;
    expect(
      parseKoharuLayoutOutputs(outputs, { width: 30, height: 30 }),
    ).toEqual([]);
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
    [40, 60, 100, 140].forEach((value, index) =>
      expect(detections[0]?.box[index]).toBeCloseTo(value),
    );
    [20, 40, 60, 80].forEach((value, index) =>
      expect(detections[1]?.box[index]).toBeCloseTo(value),
    );
    expect(detections[0]?.mask).toMatchObject({
      width: KOHARU_LAYOUT_MASK_SIZE / 2,
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

  it("merges duplicate sound effects and gives shared glyphs to the smaller lettering", () => {
    const outputs = buildOutputs([
      { query: 0, labelId: 1, probability: 0.95, box: [0.5, 0.5, 0.4, 0.4] },
      { query: 1, labelId: 1, probability: 0.85, box: [0.5, 0.5, 0.4, 0.4] },
      { query: 2, labelId: 0, probability: 0.8, box: [0.5, 0.5, 0.1, 0.1] },
    ]);
    const result = parseKoharuLayoutOutputs(outputs, {
      width: 200,
      height: 200,
    });
    const centre =
      ((KOHARU_LAYOUT_MASK_SIZE + 1) * KOHARU_LAYOUT_MASK_SIZE) / 2;
    expect(result.map((d) => d.label)).toEqual(["onomatopoeia", "text"]);
    expect(result[0].score).toBeCloseTo(0.9);
    expect(result[0].mask?.logits[centre]).toBeLessThan(0);
    expect(result[1].mask?.logits[centre]).toBeGreaterThan(0);
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
