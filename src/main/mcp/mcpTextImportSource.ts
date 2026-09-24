import { extname } from "node:path";
import { decodeImportedTextContent } from "../../shared/gatherText";
import { MCP_EXCHANGE_BYTES } from "../../shared/mcpExchangeFiles";
import type { McpTextImportSourceInfo } from "../../shared/mcpTextExchange";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpFileUploadStore } from "./mcpFileUploadStore";
import { readMcpExchangeUpload } from "./mcpExchangeUpload";

/** Ready uploaded bytes keep their existing consuming lease through the callback. */
export class McpTextImportSource {
  constructor(private readonly uploads: McpFileUploadStore) {}
  use<T>(
    owner: string,
    input: { uploadId: string; format: "txt" | "csv" | "tsv"; sha256: string },
    guard: () => void,
    consume: (source: {
      content: string;
      info: McpTextImportSourceInfo;
      verify: () => Promise<void>;
    }) => Promise<T>,
    signal?: AbortSignal,
  ) {
    return this.uploads.withFile(
      owner,
      input.uploadId,
      guard,
      async (upload) => {
        const check = () => {
          signal?.throwIfAborted();
          upload.guard();
        };
        if (
          extname(upload.input.filename).toLowerCase() !== `.${input.format}` ||
          upload.input.sha256 !== input.sha256
        )
          throw new McpEditError(
            "invalid_edit",
            "Use the exact owned upload SHA and declared text-file extension.",
          );
        const { bytes, verify } = await readMcpExchangeUpload(upload, signal);
        check();
        const content = decodeImportedTextContent(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer,
        );
        const utf8Bytes = Buffer.byteLength(content, "utf8");
        if (utf8Bytes > MCP_EXCHANGE_BYTES)
          throw new McpEditError(
            "invalid_edit",
            "Decoded native text exceeds 4 MiB when encoded as UTF-8.",
          );
        await verify();
        const result = await consume({
          content,
          verify,
          info: {
            uploadId: input.uploadId,
            sha256: upload.input.sha256,
            sourceBytes: bytes.length,
            utf8Bytes,
            format: input.format,
            decoding: "native-utf8-then-windows-949",
          },
        });
        await verify();
        return result;
      },
    );
  }
}
