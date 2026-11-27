import { readFile, writeFile } from "node:fs/promises";
import { serveInference } from "../runtimeSupport/inferenceUtilityHost";
import {
  KOHARU_LAYOUT_INPUT_SIZE,
  KOHARU_LAYOUT_MASK_SIZE,
  KOHARU_LAYOUT_QUERY_COUNT,
} from "./constants";
import { parseKoharuLayoutOutputs } from "./outputs";
import { convertBgraBitmapToRgbChw } from "./preprocess";
import type { ComicPageDetectionResult } from "./contracts";

export type SparseLayoutTransfer = {
  width: number;
  height: number;
  path: string;
} & ({ phase: "prepare"; bitmap: Uint8Array } | { phase: "decode" });

serveInference(
  async (
    request: SparseLayoutTransfer,
  ): Promise<ComicPageDetectionResult | null> => {
    const { width, height, path } = request;
    if (request.phase === "prepare") {
      const chw = convertBgraBitmapToRgbChw(
        request.bitmap,
        width,
        height,
        undefined,
        KOHARU_LAYOUT_INPUT_SIZE,
      );
      await writeFile(path, Buffer.from(chw.buffer));
      return null;
    }
    const bytes = await readFile(path);
    const count = bytes.readUInt32LE();
    const size = KOHARU_LAYOUT_MASK_SIZE;
    const queries = KOHARU_LAYOUT_QUERY_COUNT;
    if (
      count > queries ||
      bytes.length !== 4 * (1 + count + queries * 9 + count * size * size)
    ) {
      throw new Error("Invalid sparse KoharuLayout output size.");
    }
    const all = new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.length / 4,
    );
    const first = 1 + count,
      labels = first + queries * 4,
      masks = labels + queries * 5;
    const detections = parseKoharuLayoutOutputs(
      {
        queries: {
          dims: [count],
          data: new Uint32Array(bytes.buffer, bytes.byteOffset + 4, count),
        },
        dets: { dims: [1, queries, 4], data: all.subarray(first, labels) },
        labels: { dims: [1, queries, 5], data: all.subarray(labels, masks) },
        masks: { dims: [1, count, size, size], data: all.subarray(masks) },
      },
      { width, height },
    );
    return {
      imageWidth: width,
      imageHeight: height,
      executionProvider: "cuda",
      detections,
    };
  },
);
