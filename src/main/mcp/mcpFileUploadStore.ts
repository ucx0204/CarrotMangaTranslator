import { extname } from "node:path";
import { MCP_UPLOAD_CHUNK_BYTES } from "../../shared/mcpImageUploads";
import {
  MCP_FILE_UPLOAD_SESSION_BYTES,
  McpFileUploadBeginSchema,
  McpFileUploadChunkSchema,
  type McpFileUploadBegin,
  type mcpFileUploadOutputs,
} from "../../shared/mcpFileUploads";
import { McpUploadStore } from "./mcpUploadStore";
import { verifyUploadFile } from "./mcpImageUploadFiles";

type Receipt = ReturnType<
  typeof mcpFileUploadOutputs.carrot_get_file_upload.parse
>;
/** Ready is byte integrity, not permission to parse, import, run or edit a page. */
export class McpFileUploadStore extends McpUploadStore<
  McpFileUploadBegin,
  null,
  { verified: true },
  Receipt
> {
  constructor(now: () => number = Date.now) {
    super(
      {
        parse: (value) => McpFileUploadBeginSchema.parse(value),
        chunk: (value) => McpFileUploadChunkSchema.parse(value),
        filename: (input, id) =>
          `${id}${extname(input.filename).toLowerCase()}`,
        maxFiles: 16,
        maxBytes: MCP_FILE_UPLOAD_SESSION_BYTES,
        capacityMessage:
          "Incoming files share 16 files / 256 MiB / 256 receipt reservations per session. Discard unused uploads. No library data was changed.",
        validate: async (input, path, guard) => {
          await verifyUploadFile(path, input.bytes, input.sha256, guard);
          return { verified: true };
        },
        project: ({ id, input, received, expiresAt, ready }) => ({
          uploadId: id,
          filename: input.filename,
          status: ready ? "ready" : "receiving",
          validation: ready ? "bytes-verified" : "pending",
          expectedBytes: input.bytes,
          receivedBytes: received,
          sha256: input.sha256,
          expiresAt,
          chunkBytes: MCP_UPLOAD_CHUNK_BYTES,
          retention: "session-only",
          importable: "not-yet-checked",
        }),
      },
      now,
    );
  }
}
