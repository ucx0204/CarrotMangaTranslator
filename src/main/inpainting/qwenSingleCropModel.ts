import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { InferenceSession } from "onnxruntime-node";
import { qwenSubstrateAsset } from "./qwenImageAssets";

// The pinned export has over 17,000 nodes. Its Fourier blocks repeatedly
// compute shapes at runtime when batch is symbolic. Every substrate invocation
// has one image and one mask. Declare that existing contract in GraphProto.
const singleCropDigest =
  "e000ed643d84593d28432c63f04b1d1a91123f3450c8ba65b1e8b4f009ccaea4";
function lengthPrefix(length: number) {
  const bytes = [];
  while (length >= 128) {
    bytes.push((length % 128) + 128);
    length = Math.floor(length / 128);
  }
  return Buffer.from([...bytes, length]);
}

function message(field: number, contents: Buffer) {
  return Buffer.concat([
    Buffer.from([8 * field + 2]),
    lengthPrefix(contents.length),
    contents,
  ]);
}

function tensorInfo(field: number, name: string, channels: number) {
  const dims = [1, channels, 512, 512].map((n) =>
    message(1, Buffer.concat([Buffer.from([8]), lengthPrefix(n)])),
  );
  const tensor = Buffer.concat([
    Buffer.from([8, 1]),
    message(2, Buffer.concat(dims)),
  ]);
  return message(
    field,
    Buffer.concat([
      message(1, Buffer.from(name)),
      message(2, message(1, tensor)),
    ]),
  );
}

/** Rewrite the three ValueInfoProto descriptors in our pinned ONNX export.
 * The working buffer is private to the loader. Nodes and tensors stay in place. */
export function declareQwenCropShape(model: Buffer) {
  const graphTag = model.indexOf(0x3a);
  const firstInput = model.lastIndexOf(
    Buffer.from([0x5a, 38, 10, 5, ...Buffer.from("image")]),
  );
  if (graphTag < 0 || firstInput <= graphTag) return;
  let firstNode = graphTag + 1;
  while (firstNode < firstInput && model[firstNode++] >= 128) {
    /* skip GraphProto length */
  }
  const opset = model.length - 4;
  const signature = Buffer.concat([
    tensorInfo(11, "image", 3),
    tensorInfo(11, "mask", 1),
    tensorInfo(12, "output", 3),
  ]);
  const graphLength = lengthPrefix(firstInput - firstNode + signature.length);
  if (
    graphLength.length !== firstNode - graphTag - 1 ||
    firstInput + signature.length > opset
  )
    return;
  graphLength.copy(model, graphTag + 1);
  signature.copy(model, firstInput);
  const end = firstInput + signature.length;
  model.copy(model, end, opset);
  return model.subarray(0, end + 4);
}

const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
async function verifiedSingleCrop(path: string) {
  const original = await readFile(path);
  if (
    original.length !== qwenSubstrateAsset.bytes ||
    digest(original) !== qwenSubstrateAsset.sha256
  )
    return;
  const model = declareQwenCropShape(original);
  if (model && digest(model) === singleCropDigest) return model;
}

export async function openQwenFloatSession(
  factory: typeof InferenceSession,
  path: string,
  options: InferenceSession.SessionOptions,
  singleCrop: boolean,
) {
  if (singleCrop && basename(path) === qwenSubstrateAsset.file) {
    const model = await verifiedSingleCrop(path);
    if (model) return factory.create(model, options);
  }
  return factory.create(path, options);
}
