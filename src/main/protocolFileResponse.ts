import { open } from "node:fs/promises";

const IMMUTABLE_CACHE_CONTROL = "private, max-age=31536000, immutable";
const EXPECTED_FILE_ERROR_CODES = new Set([
  "EACCES",
  "EINVAL",
  "EISDIR",
  "ELOOP",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
]);

type ProtocolFileVersion = {
  size: string;
  mtimeNs: string;
};

type ProtocolFileResponseOptions = {
  contentType: string;
  expectedVersion?: ProtocolFileVersion;
};

class ProtocolFileUnavailableError extends Error {}

export async function createProtocolFileResponse(
  filePath: string,
  options: ProtocolFileResponseOptions,
): Promise<Response> {
  const fileHandle = await open(filePath, "r");
  try {
    const stats = await fileHandle.stat({ bigint: true });
    if (
      !stats.isFile() ||
      (options.expectedVersion &&
        (stats.size.toString() !== options.expectedVersion.size ||
          stats.mtimeNs.toString() !== options.expectedVersion.mtimeNs))
    ) {
      throw new ProtocolFileUnavailableError(
        "The requested file is no longer available.",
      );
    }
    const body = fileHandle.readableWebStream({
      autoClose: true,
    }) as unknown as BodyInit;
    return new Response(body, {
      headers: {
        "Cache-Control": IMMUTABLE_CACHE_CONTROL,
        "Content-Length": stats.size.toString(),
        "Content-Type": options.contentType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    try {
      await fileHandle.close();
    } catch (_closeError) {
      // error-policy-allow: preserve the original response construction failure.
    }
    throw error;
  }
}

export function isProtocolFileUnavailableError(error: unknown): boolean {
  return (
    error instanceof ProtocolFileUnavailableError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      EXPECTED_FILE_ERROR_CODES.has(error.code))
  );
}
