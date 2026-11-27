import { join } from "node:path";
import type { InferenceSession, Tensor } from "onnxruntime-node";
import { InferenceUtilityProcess } from "../runtimeSupport/inferenceUtilityProcess";
import { openQwenFloatSession } from "./qwenSingleCropModel";

type FloatPlane = { data: Float32Array; dims: readonly number[] };
type Request = {
  modelPath: string;
  threads: number;
  inputs: (FloatPlane & { name?: string })[];
};

export function createQwenFloatProcess() {
  return new InferenceUtilityProcess<Request, FloatPlane>(
    join(__dirname, "qwenFloatWorker.js"),
    "Qwen artwork CPU inference",
  );
}

/** A process belongs to one substrate or verifier. Its session dies with it. */
export function createQwenFloatInference() {
  let session: InferenceSession | undefined;
  return async ({
    modelPath,
    threads,
    inputs,
  }: Request): Promise<FloatPlane> => {
    const { onnxRuntimeNode: ort } =
      await import("../runtimeSupport/nativeOnnxRuntime.js");
    session ??= await openQwenFloatSession(
      ort.InferenceSession,
      modelPath,
      {
        executionProviders: ["cpu"],
        intraOpNumThreads: threads,
        interOpNumThreads: 1,
      },
      inputs.length === 2 &&
        inputs[0].name === "image" &&
        inputs[1].name === "mask" &&
        inputs[0].dims.join(",") === "1,3,512,512" &&
        inputs[1].dims.join(",") === "1,1,512,512",
    );
    const feeds: Record<string, Tensor> = {};
    let values: InferenceSession.ReturnType = {};
    try {
      for (const { name, data, dims } of inputs)
        feeds[name ?? session.inputNames[0]] = new ort.Tensor(
          "float32",
          data,
          dims,
        );
      values = await session.run(feeds);
      const output = values[session.outputNames[0]];
      if (!(output?.data instanceof Float32Array))
        throw new Error("Qwen CPU 모델의 출력 형식이 올바르지 않습니다.");
      return { data: output.data, dims: output.dims };
    } finally {
      for (const tensor of Object.values(values)) tensor.dispose();
      for (const tensor of Object.values(feeds)) tensor.dispose();
    }
  };
}
