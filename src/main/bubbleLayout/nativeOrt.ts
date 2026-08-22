import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type * as Ort from "onnxruntime-node";

const localRequire = createRequire(__filename);

/**
 * The packaged native runtime lives at a deliberately short resource path.
 * NSIS' Fast ZIP extractor rejects the normal app.asar.unpacked node_modules
 * path. Development and tests continue to resolve the ordinary npm package.
 */
export const onnxRuntimeNode: typeof Ort = loadOnnxRuntimeNode();

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
