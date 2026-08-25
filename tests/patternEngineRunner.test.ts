import { describe, expect, it, vi } from "vitest";
import type { InpaintingEngine } from "../src/main/inpainting/inpaintingEngine";
import { createEmptyPatternMaskContext } from "../src/main/inpainting/patternMaskContext";
import { runPatternInpaintingEngine } from "../src/main/inpainting/patternEngineRunner";

describe("runPatternInpaintingEngine", () => {
  it("keeps CUDA Flux windows aligned with composite masks without constraints", async () => {
    const inpaint = vi.fn().mockResolvedValue(undefined);
    const engine: InpaintingEngine = {
      model: "flux-klein",
      backend: "cuda-native",
      runtimePath: "/tmp/runtime",
      runRootDir: "/tmp/run",
      inpaint,
      async dispose() {},
    };
    const context = createEmptyPatternMaskContext(40, 20);
    const windows = [
      { x: 0, y: 0, w: 20, h: 20 },
      { x: 20, y: 0, w: 20, h: 20 },
    ];
    const masks = windows.map((bounds) => ({
      bounds,
      data: new Uint8Array(bounds.w * bounds.h).fill(1),
    }));
    context.inpaintWindows = windows;
    context.inpaintWindowMasks = masks;
    context.inpaintCompositeMasks = masks;
    context.inpaintCompositeFeatherPx = [0, 0];
    context.inpaintWindowConstraints = [null, null];
    context.inpaintWindowGroupIds = [[], []];

    await runPatternInpaintingEngine({
      bitmap: Buffer.alloc(40 * 20 * 4),
      engine,
      height: 20,
      maskContext: context,
      width: 40,
    });

    expect(inpaint).toHaveBeenCalledOnce();
    const passedWindows = inpaint.mock.calls[0]?.[4];
    const runOptions = inpaint.mock.calls[0]?.[5];
    expect(passedWindows).toEqual(windows);
    expect(passedWindows).toHaveLength(runOptions.compositeMasks.length);
    expect(runOptions.compositeConstraints).toBeUndefined();
  });
});
