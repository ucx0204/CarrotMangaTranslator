import { freemem } from "node:os";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { serialize, deserialize } from "node:v8";
import { promisify } from "node:util";
import { deflateRaw, inflateRaw } from "node:zlib";
import type {
  ComicPageDetectionResult,
  NativeLayoutRequest,
} from "./contracts";

const pack = promisify(deflateRaw);
const unpack = promisify(inflateRaw);
type Infer = (
  input: NativeLayoutRequest,
  signal?: AbortSignal,
) => Promise<ComicPageDetectionResult>;

/** Detection, OCR and erasure can request the same decoded pixels in separate
 * jobs. Keep only bounded CPU bytes, independent of the inference session. */
export function cacheNativeLayoutResults(
  infer: Infer,
  byteLimit = Math.min(384 * 1024 * 1024, Math.floor(freemem() / 20)),
) {
  const cache = new Map<string, Buffer>();
  let bytes = 0;
  function remember(key: string, data: Buffer) {
    // Concurrent jobs may have completed the same request independently.
    if (data.length > byteLimit || cache.has(key)) return;
    while (cache.size >= 96 || bytes + data.length > byteLimit) {
      const oldest = cache.entries().next();
      if (oldest.done) break;
      bytes -= oldest.value[1].length;
      cache.delete(oldest.value[0]);
    }
    cache.set(key, data);
    bytes += data.length;
  }
  return async (input: NativeLayoutRequest, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const providers = input.providerPreference;
    if (!supportsCachedProvider(providers)) return infer(input, signal);
    const key = await inputFingerprint(input);
    signal?.throwIfAborted();
    const gpuKey = adapterKey(key, input);
    const hitKey = !providers && cache.has(gpuKey) ? gpuKey : key;
    const hit = cache.get(hitKey);
    if (hit) {
      cache.delete(hitKey);
      cache.set(hitKey, hit);
      const raw = await unpack(hit);
      signal?.throwIfAborted();
      return deserialize(raw) as ComicPageDetectionResult;
    }
    const result = await infer(input, signal);
    signal?.throwIfAborted();
    if (!cacheable(result, byteLimit)) return result;
    const data = await pack(serialize(result), { level: 1 });
    signal?.throwIfAborted();
    remember(result.executionProvider === "cuda" ? gpuKey : key, data);
    return result;
  };
}

function supportsCachedProvider(
  providers: NativeLayoutRequest["providerPreference"],
) {
  return !providers || (providers.length === 1 && providers[0] === "cpu");
}

function cacheable(result: ComicPageDetectionResult, byteLimit: number) {
  const size = result.detections.reduce(
    (n, d) => n + (d.mask?.logits.byteLength ?? 0),
    0,
  );
  return (
    (result.executionProvider === "cpu" ||
      result.executionProvider === "cuda") &&
    size <= byteLimit
  );
}

function adapterKey(key: string, input: NativeLayoutRequest) {
  return key + JSON.stringify(input.directMl ?? {});
}

async function inputFingerprint(input: NativeLayoutRequest) {
  const path = resolve(input.modelPath);
  const info = await stat(path, { bigint: true });
  return JSON.stringify([
    path,
    String(info.ino),
    String(info.size),
    String(info.ctimeNs),
    String(info.mtimeNs),
    input.width,
    input.height,
    createHash("sha256").update(input.bitmap).digest("hex"),
  ]);
}
