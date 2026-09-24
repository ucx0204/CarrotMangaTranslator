import {
  MCP_UPLOAD_CHUNK_BYTES,
  MCP_UPLOAD_SESSION_BYTES,
  McpImageUploadBeginSchema,
  McpImageUploadChunkSchema,
  type McpImageUploadBegin,
  type mcpImageUploadOutputs,
} from "../../shared/mcpImageUploads";
import type { McpImageFileEvidence } from "../application/mcpImageEditPolicy";
import { decodeMcpUploadPng } from "./mcpImageUploadPng";
import { readImageUploadFile } from "./mcpImageUploadFiles";
import { McpUploadStore } from "./mcpUploadStore";

type Validation = { hasTransparency: boolean; selectedPixels: number | null };
type Receipt = ReturnType<
  typeof mcpImageUploadOutputs.carrot_get_image_upload.parse
>;

/** Image-edit authority stays page/context bound; only transport lifecycle is shared. */
export class McpImageUploadStore extends McpUploadStore<
  McpImageUploadBegin,
  McpImageFileEvidence[],
  Validation,
  Receipt
> {
  constructor(now: () => number = Date.now) {
    super(
      {
        parse: (value) => McpImageUploadBeginSchema.parse(value),
        chunk: (value) => McpImageUploadChunkSchema.parse(value),
        filename: (_input, id) => `${id}.png`,
        maxFiles: 32,
        maxBytes: MCP_UPLOAD_SESSION_BYTES,
        capacityMessage:
          "Upload session capacity reached (32 files / 128 MiB / 256 receipts). Discard unneeded uploads; no source file was changed.",
        validate: async (input, path, guard) => {
          const bytes = await readImageUploadFile(
            path,
            input.bytes,
            input.sha256,
          );
          guard();
          const { hasTransparency, selectedPixels } = decodeMcpUploadPng(
            bytes,
            input,
          );
          return { hasTransparency, selectedPixels };
        },
        project: ({ id, input, received, expiresAt, ready }) => ({
          uploadId: id,
          chapterId: input.chapterId,
          pageId: input.pageId,
          revision: input.revision,
          purpose: input.purpose,
          mimeType: input.mimeType,
          status: ready ? "ready" : "receiving",
          expectedBytes: input.bytes,
          receivedBytes: received,
          sha256: input.sha256,
          width: input.width,
          height: input.height,
          expiresAt,
          chunkBytes: MCP_UPLOAD_CHUNK_BYTES,
          hasTransparency: ready?.hasTransparency ?? null,
          selectedPixels: ready?.selectedPixels ?? null,
        }),
      },
      now,
    );
  }
  use<T>(
    owner: string,
    id: string,
    guard: () => void,
    consume: (asset: {
      input: McpImageUploadBegin;
      files: McpImageFileEvidence[];
      bytes: Buffer;
      expiresAt: number;
      guard: () => void;
    }) => Promise<T>,
  ): Promise<T> {
    return this.withFile(owner, id, guard, async (asset) => {
      const bytes = await readImageUploadFile(
        asset.path,
        asset.input.bytes,
        asset.input.sha256,
      );
      asset.guard();
      return consume({
        input: asset.input,
        files: asset.files,
        bytes,
        expiresAt: asset.expiresAt,
        guard: asset.guard,
      });
    });
  }
}
