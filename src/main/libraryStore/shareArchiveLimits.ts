import { Transform } from "node:stream";

/** Optional caller admission limits. Existing native exports keep their defaults. */
export type ShareArchiveLimits = {
  maxOutputBytes: number;
  maxEntries: number;
  maxUncompressedBytes: number;
};

export function validateShareArchiveLimits(limits?: ShareArchiveLimits): void {
  if (
    limits &&
    [
      limits.maxOutputBytes,
      limits.maxEntries,
      limits.maxUncompressedBytes,
    ].some((value) => !Number.isSafeInteger(value) || value <= 0)
  )
    throw new Error("Share archive limits must be positive safe integers.");
}

/** Counts actual ZIP bytes, including headers, before they reach the file. */
export function createShareArchiveOutputLimiter(maxBytes: number): Transform {
  let written = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      if (written > maxBytes) {
        callback(new Error("Share archive exceeds its output byte limit."));
        return;
      }
      callback(null, chunk);
    },
  });
}
