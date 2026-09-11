import type { IncomingMessage } from "node:http";
import { McpHttpError } from "./mcpHttpPolicy";

const MAX_BODY_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 10_000;

export async function readMcpBody(request: IncomingMessage): Promise<unknown> {
  const bytes = await readBoundedBody(request);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch (_error) {
    throw new McpHttpError(400, "Invalid UTF-8 JSON body.");
  }
}

function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
      if (error) {
        request.resume();
        reject(error);
      } else {
        resolve(Buffer.concat(chunks, size));
      }
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES)
        finish(new McpHttpError(413, "Request body is too large."));
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = () =>
      finish(new McpHttpError(400, "Request body could not be read."));
    const onAborted = () =>
      finish(new McpHttpError(400, "Request was aborted."));
    const timer = setTimeout(
      () => finish(new McpHttpError(408, "Request body timed out.")),
      BODY_TIMEOUT_MS,
    );
    timer.unref();
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}
