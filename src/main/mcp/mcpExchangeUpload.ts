import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { MCP_EXCHANGE_BYTES } from "../../shared/mcpExchangeFiles";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpFileUploadStore } from "./mcpFileUploadStore";
import { verifyUploadFile } from "./mcpImageUploadFiles";

export type McpExchangeUploadAsset = Parameters<
  Parameters<McpFileUploadStore["withFile"]>[3]
>[0];

/** Call only inside withFile and retain that lease until all consumption settles. */
export async function readMcpExchangeUpload(
  asset: McpExchangeUploadAsset,
  signal?: AbortSignal,
) {
  const guard = () => {
    signal?.throwIfAborted();
    asset.guard();
  };
  guard();
  if (asset.input.bytes < 1 || asset.input.bytes > MCP_EXCHANGE_BYTES)
    throw new McpEditError(
      "invalid_edit",
      "Exchange input exceeds the 4 MiB encoded-byte limit.",
    );
  const verify = async () => {
    guard();
    await verifyUploadFile(
      asset.path,
      asset.input.bytes,
      asset.input.sha256,
      guard,
    );
    guard();
  };
  await verify();
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(asset.path, { signal })) {
    guard();
    size += chunk.length;
    if (size > asset.input.bytes || size > MCP_EXCHANGE_BYTES)
      throw new McpEditError(
        "invalid_edit",
        "Exchange input changed or exceeds its admitted byte limit.",
      );
    hash.update(chunk);
    chunks.push(chunk);
  }
  if (size !== asset.input.bytes || hash.digest("hex") !== asset.input.sha256)
    throw new McpEditError(
      "revision_conflict",
      "Exchange input bytes changed after verification.",
    );
  await verify();
  return {
    bytes: Buffer.concat(chunks, size),
    filename: asset.input.filename,
    sha256: asset.input.sha256,
    verify,
  };
}
