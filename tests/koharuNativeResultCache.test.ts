import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cacheNativeLayoutResults } from "../src/main/bubbleLayout/nativeResultCache";
import type { ComicPageDetectionResult } from "../src/main/bubbleLayout/contracts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(limit?: number) {
  const dir = await mkdtemp(join(tmpdir(), "koharu-cpu-cache-"));
  roots.push(dir);
  const modelPath = join(dir, "layout.onnx");
  await writeFile(modelPath, "fixture");
  const result = (): ComicPageDetectionResult => ({
    imageWidth: 1,
    imageHeight: 1,
    executionProvider: "cpu",
    detections: [
      {
        labelId: 0,
        label: "bubble",
        box: [0, 0, 1, 1],
        score: 0.75,
        mask: { width: 1, height: 1, logits: new Float32Array([-0.125]) },
      },
    ],
  });
  const infer = vi.fn(async () => result());
  return {
    infer,
    run: cacheNativeLayoutResults(infer, limit),
    req: {
      modelPath,
      width: 1,
      height: 1,
      bitmap: new Uint8Array([1, 2, 3, 255]),
    },
  };
}
it("reuses unchanged CPU logits and gives every caller an isolated result", async () => {
  const { run, infer, req } = await fixture();
  const first = await run(req);
  first.detections[0].box[0] = 3;
  const second = await run({ ...req, providerPreference: ["cpu"] });
  expect(second.detections[0].box[0]).toBe(0);
  expect(second.detections[0].mask?.logits).toBeInstanceOf(Float32Array);
  expect(second.detections[0].mask?.logits[0]).toBe(-0.125);
  await run({ ...req, bitmap: new Uint8Array(4) });
  await run({ ...req, width: 2 });
  await writeFile(req.modelPath, "fixture-v2");
  await run(req);
  await run({ ...req, providerPreference: ["dml", "cpu"] });
  expect(infer).toHaveBeenCalledTimes(5);
});
it("bounds storage and honours cancellation and inference errors", async () => {
  const { run, infer, req } = await fixture(1);
  await run(req);
  await run(req);
  expect(infer).toHaveBeenCalledTimes(2);
  await expect(run(req, AbortSignal.abort())).rejects.toThrow();
  infer.mockRejectedValueOnce(new Error("failure"));
  await expect(run(req)).rejects.toThrow("failure");
  await run(req);
  expect(infer).toHaveBeenCalledTimes(4);
});

it("isolates CUDA adapter results and reuses CPU results only for a CPU-only request", async () => {
  const { infer, run, req } = await fixture();
  const gpu = await infer();
  gpu.executionProvider = "cuda";
  infer.mockClear();
  infer.mockResolvedValueOnce(gpu);
  expect((await run(req)).executionProvider).toBe("cuda");
  expect((await run(req)).executionProvider).toBe("cuda");
  expect(
    (await run({ ...req, providerPreference: ["cpu"] })).executionProvider,
  ).toBe("cpu");
  expect((await run(req)).executionProvider).toBe("cuda");
  expect(infer).toHaveBeenCalledTimes(2);
});
