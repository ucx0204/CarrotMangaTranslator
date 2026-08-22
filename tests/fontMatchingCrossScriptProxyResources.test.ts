import type * as Ort from "onnxruntime-node";
import { describe, expect, it, vi } from "vitest";
import { runDisposableFloatTensorStage } from "../src/main/runtimeSupport/nativeOnnxRuntime";

describe("native ONNX tensor stages", () => {
  it("disposes every per-run input and output after synchronous consumption", async () => {
    const input = fakeTensor(new Float32Array([1]), [1]);
    const expected = new Float32Array([2, 3]);
    const selectedOutput = fakeTensor(expected, [1, 2]);
    const unusedOutput = fakeTensor(new Float32Array([4]), [1]);
    const session = {
      run: vi.fn(async () => ({
        selected: selectedOutput,
        unused: unusedOutput,
      })),
    };

    const result = await runDisposableFloatTensorStage({
      session,
      inputName: "input",
      input,
      outputName: "selected",
      expectedDimensions: [1, 2],
      consume: (values) => [...values],
    });

    expect(result).toEqual([2, 3]);
    expect(input.dispose).toHaveBeenCalledOnce();
    expect(selectedOutput.dispose).toHaveBeenCalledOnce();
    expect(unusedOutput.dispose).toHaveBeenCalledOnce();
  });

  it("still disposes feeds and malformed fetches when the output contract fails", async () => {
    const input = fakeTensor(new Float32Array([1]), [1]);
    const malformed = fakeTensor(new Float32Array([2]), [2]);
    const session = {
      run: vi.fn(async () => ({ selected: malformed })),
    };

    await expect(
      runDisposableFloatTensorStage({
        session,
        inputName: "input",
        input,
        outputName: "selected",
        expectedDimensions: [1, 2],
        consume: (values) => values,
      }),
    ).rejects.toThrow("float output contract drifted");
    expect(input.dispose).toHaveBeenCalledOnce();
    expect(malformed.dispose).toHaveBeenCalledOnce();
  });
});

function fakeTensor(data: Float32Array, dims: readonly number[]) {
  return {
    type: "float32",
    data,
    dims,
    dispose: vi.fn(),
  } as Ort.Tensor & { dispose: ReturnType<typeof vi.fn> };
}
