import { open } from "node:fs/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

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
  /**
   * true면 응답에 Access-Control-Allow-Origin: * 를 추가한다. mgt-font:// 커스텀
   * 폰트는 file:// origin 페이지에서 교차 출처로 fetch되므로(corsEnabled 스킴)
   * CORS 헤더가 없으면 브라우저가 차단하고 빈 바디를 디코드하려다 OTS 에러가
   * 난다. mgt-image는 <img>로 불러 CORS가 필요 없으므로 false를 유지한다.
   */
  corsEnabled?: boolean;
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
    const body = createResponseBody(
      fileHandle.readableWebStream({
        autoClose: true,
      }),
    );
    return new Response(body, {
      headers: {
        "Cache-Control": IMMUTABLE_CACHE_CONTROL,
        "Content-Length": stats.size.toString(),
        "Content-Type": options.contentType,
        "X-Content-Type-Options": "nosniff",
        ...(options.corsEnabled ? { "Access-Control-Allow-Origin": "*" } : {}),
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

/**
 * Adapts Node's web-stream type to the DOM stream accepted by Response while
 * validating the runtime chunk contract at the boundary.
 */
function createResponseBody(
  source: NodeReadableStream,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }
        const chunk = toResponseChunk(result.value);
        if (!chunk) {
          const error = new TypeError(
            "Protocol file stream emitted a non-binary chunk.",
          );
          await reader.cancel(error);
          controller.error(error);
          return;
        }
        controller.enqueue(chunk);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function toResponseChunk(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (value instanceof Uint8Array) {
    return value.buffer instanceof ArrayBuffer
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : Uint8Array.from(value);
  }
  return null;
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
