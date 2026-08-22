import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type * as Ort from "onnxruntime-node";

const localRequire = createRequire(__filename);

/**
 * Shared native ONNX Runtime loader.
 *
 * Packaged builds deliberately omit node_modules/onnxruntime-node and stage
 * only the target-platform runtime under the short resources/o path. Keeping
 * this resolution in runtimeSupport prevents individual model domains from
 * accidentally working in development while failing in an installer.
 */
export const onnxRuntimeNode: typeof Ort = loadOnnxRuntimeNode();

type NativeOnnxRunSession = Readonly<{
  run: (
    feeds: Readonly<Record<string, Ort.Tensor>>,
  ) => Promise<Ort.InferenceSession.ReturnType>;
}>;

function loadOnnxRuntimeNode(): typeof Ort {
  const packagedEntry = resolvePackagedOnnxRuntimeNodeEntry();
  return localRequire(packagedEntry ?? "onnxruntime-node") as typeof Ort;
}

/** @public Dynamically consumed by the packaged native-runtime smoke test. */
export function resolvePackagedOnnxRuntimeNodeEntry(): string | null {
  if (!process.resourcesPath) return null;
  const entry = join(process.resourcesPath, "o", "index.js");
  return existsSync(entry) ? entry : null;
}

/**
 * Run one native tensor stage and release both feeds and fetches after the
 * caller has synchronously copied/consumed the selected float output.
 */
export async function runDisposableFloatTensorStage<T>({
  session,
  inputName,
  input,
  outputName,
  expectedDimensions,
  consume,
}: Readonly<{
  session: NativeOnnxRunSession;
  inputName: string;
  input: Ort.Tensor;
  outputName: string;
  expectedDimensions: readonly number[];
  consume: (values: Float32Array) => T;
}>): Promise<T> {
  let outputs: Ort.InferenceSession.ReturnType | null = null;
  try {
    outputs = await session.run({ [inputName]: input });
    const output = outputs[outputName];
    if (
      !output ||
      output.type !== "float32" ||
      !sameDimensions(output.dims, expectedDimensions) ||
      !(output.data instanceof Float32Array)
    ) {
      throw new Error(
        `Native ONNX float output contract drifted: ${outputName}`,
      );
    }
    return consume(output.data);
  } finally {
    disposeOnnxValue(input);
    if (outputs) {
      for (const output of Object.values(outputs)) disposeOnnxValue(output);
    }
  }
}

function disposeOnnxValue(value: unknown): void {
  if (
    typeof value === "object" &&
    value !== null &&
    "dispose" in value &&
    typeof value.dispose === "function"
  ) {
    value.dispose();
  }
}

function sameDimensions(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
