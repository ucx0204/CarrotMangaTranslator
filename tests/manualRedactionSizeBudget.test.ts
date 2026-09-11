import { expect, it } from "vitest";
import {
  DEFAULT_REDACTION_PREFERENCES,
  DEFAULT_REDACTION_VIEW,
  redactionPresetSchema,
  redactionWorkspaceSchema,
} from "../src/shared/imageRedactionWorkspace";
import { imageRedactionReviewSchema } from "../src/shared/imageRedaction";
import { isSupportedRedactionSize } from "../src/shared/imageRedactionLimits";
import { rasterizeImageRedaction } from "../src/shared/imageRedactionRaster";

const sessionId = "11111111-1111-4111-8111-111111111111";
function accepted(width: number, height: number) {
  const page = {
    id: "a",
    name: "a",
    imagePath: "a.png",
    width,
    height,
    fingerprint: "a".repeat(64),
    strokes: [],
  };
  const workspace = {
    sessionId,
    revision: 0,
    pages: [{ ...page, decision: "unreviewed" }],
    view: DEFAULT_REDACTION_VIEW,
    preferences: DEFAULT_REDACTION_PREFERENCES,
    presets: [],
  };
  const preset = {
    id: sessionId,
    name: "mask",
    width,
    height,
    strokes: [{ shape: "square", size: 1, points: [{ x: 0, y: 0 }] }],
  };
  return [
    isSupportedRedactionSize(page),
    redactionWorkspaceSchema.safeParse(workspace).success,
    imageRedactionReviewSchema.safeParse({ sessionId, pages: [page] }).success,
    redactionPresetSchema.safeParse(preset).success,
  ];
}
it.each([
  [100001, 1],
  [1, 100001],
  [12000, 10001],
  [0, 1],
  [1.5, 2],
])(
  "rejects unsupported %i x %i metadata before allocation across all redaction entries",
  (width, height) => {
    expect(accepted(width, height)).toEqual([false, false, false, false]);
    expect(() => rasterizeImageRedaction(width, height, [])).toThrow();
  },
);
it.each([
  [100000, 1],
  [1, 100000],
  [12000, 10000],
  [20, 20],
])(
  "uses the exact source budget for supported %i x %i metadata without allocating big test masks",
  (width, height) =>
    expect(accepted(width, height)).toEqual([true, true, true, true]),
);
