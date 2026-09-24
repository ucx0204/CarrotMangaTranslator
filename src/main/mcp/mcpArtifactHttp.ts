import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { McpArtifactStore } from "./mcpArtifactStore";
import { McpHttpError } from "./mcpHttpPolicy";
import {
  observeMcpOutputResponse,
  observeMcpOutputSource,
} from "./mcpOutputDeliveryHttp";
import type { McpOutputDeliveryTransfer } from "./mcpOutputDeliveryObserver";

/** Called only after the shared Host/Origin, stopping and concurrency checks.
 * Never accepts a pathname; the unguessable identifier resolves one owned output. */
export async function handleMcpArtifact(
  store: McpArtifactStore | undefined,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  if (!store || !request.url?.startsWith("/mcp-artifacts/")) return false;
  const match =
    /^\/mcp-artifacts\/([A-Za-z0-9_-]{43})\/(page\.(?:png|jpg|webp|psd)|pages\.zip|work\.mgtshare|text\.txt|review\.(?:csv|tsv)|context\.json)$/.exec(
      request.url,
    );
  if (!match) throw new McpHttpError(404, "Output not found.");
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new McpHttpError(405, "Only GET and HEAD are allowed for outputs.");
  const output = await readOutput(store, match[1], match[2]);
  if (response.destroyed || response.writableEnded) return true;
  response.statusCode = 200;
  response.setHeader("Content-Type", output.mimeType);
  response.setHeader("Content-Length", output.bytes);
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="${output.filename}"`,
  );
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  await sendOutput(response, output, request.method === "HEAD");
  return true;
}

async function sendOutput(
  response: ServerResponse,
  output: Awaited<ReturnType<typeof readOutput>>,
  head: boolean,
): Promise<void> {
  const transfer = output.beginHttp(head ? "HEAD" : "GET");
  observeMcpOutputResponse(response, transfer);
  try {
    if (head) response.end();
    else if ("data" in output) {
      transfer.bytesQueued(output.data.length);
      response.end(output.data);
    } else {
      await sendStream(response, output.stream(transfer), transfer);
    }
  } catch (error) {
    transfer.fail();
    throw error;
  }
}

/** Preserve native pipeline completion, disconnect teardown and producer error observation. */
async function sendStream(
  response: ServerResponse,
  source: Readable,
  transfer: McpOutputDeliveryTransfer,
): Promise<void> {
  const cleanup = observeMcpOutputSource(source, transfer);
  try {
    // pipeline applies backpressure and destroys the source on disconnect.
    // The store rechecks grant, revision, redaction and expiry for every chunk.
    await pipeline(source, response);
  } catch (error) {
    if (
      response.destroyed &&
      (error as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE"
    )
      return;
    throw error;
  } finally {
    cleanup();
  }
}

async function readOutput(
  store: McpArtifactStore,
  secret: string,
  name: string,
) {
  try {
    // Bind the requested suffix to the owned entry before selecting a reader.
    const output = await store.open(secret, name);
    // Preserve the existing PNG read verification, including read failures.
    if (name !== "pages.zip" && name !== "work.mgtshare")
      return { ...output, data: await store.read(secret) };
    return output;
  } catch (_error) {
    // Do not reveal whether denial came from expiry, permission or redaction.
    throw new McpHttpError(
      404,
      "Output is unavailable. Export it again from the app.",
    );
  }
}
