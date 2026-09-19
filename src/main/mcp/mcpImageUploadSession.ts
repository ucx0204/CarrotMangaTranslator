import {
  McpImageUploadBeginSchema,
  McpImageUploadChunkSchema,
  McpImageUploadGetSchema,
} from "../../shared/mcpImageUploads";
import { mcpContextRevision } from "../../shared/mcpContextEditing";
import { readWorkContextForEdit } from "../library";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  captureMcpImageFiles,
  readMcpImageEditPage,
  verifyMcpImageFiles,
} from "./mcpImageEditEvidence";
import { McpImageUploadStore } from "./mcpImageUploadStore";
import { createMcpBatchTool } from "./mcpBatchTool";

export function createMcpImageUploadSession(lifetime: AbortSignal) {
  const store = new McpImageUploadStore();
  const scopes = ["carrot.read", "carrot.edit", "carrot.process"];
  const checked = (guard: () => void) => () => {
    lifetime.throwIfAborted();
    guard();
  };
  const tools = [
    createMcpBatchTool({
      name: "carrot_begin_image_upload",
      schema: McpImageUploadBeginSchema,
      scopes,
      write: true,
      description:
        "Reserve one owned, page/version/context-bound PNG upload (32 MiB/file, 128 MiB and 32 files/session, fixed 30-minute expiry). Send actual file bytes using write_image_upload chunks, then finish_image_upload. Declared SHA-256 is NOT verified until ready. Only complete 8-bit nonanimated PNG is supported. Binary masks must be opaque black/white. No URL/path/file-reference fetching, inference, downloads, settings changes or page edits. Client must support delivering bytes; a filename is not an upload.",
      execute: async (value, owner, guard) => {
        const input = McpImageUploadBeginSchema.parse(value),
          check = checked(guard);
        const saved = await readWorkContextForEdit(input.chapterId);
        check();
        if (mcpContextRevision(saved) !== input.contextRevision)
          throw new McpEditError(
            "revision_conflict",
            "Work context changed before upload reservation.",
          );
        const page = await readMcpImageEditPage(input, check);
        const files = await captureMcpImageFiles(page, check);
        await readMcpImageEditPage(input, check);
        await verifyMcpImageFiles(files, check);
        return store.begin(owner, input, files, check);
      },
    }),
    createMcpBatchTool({
      name: "carrot_write_image_upload",
      schema: McpImageUploadChunkSchema,
      scopes,
      write: true,
      description:
        "Append at most 32 KiB of actual PNG bytes as canonical base64 at receivedBytes. Exact chunk retries are accepted; changed repeats, gaps, overlaps and overflow are rejected. Never pass a client file handle, path or filename as data. This changes only the owned staging file, not a page.",
      execute: (args, owner, guard) => store.chunk(owner, args, checked(guard)),
    }),
    createMcpBatchTool({
      name: "carrot_finish_image_upload",
      schema: McpImageUploadGetSchema,
      scopes,
      write: true,
      description:
        "Validate received length, SHA-256, PNG structure/CRC, exact declared dimensions and binary-mask semantics. Returns ready only after actual bytes validate. No page application, image transfer, model or automatic format conversion.",
      execute: (args, owner, guard) =>
        store.finish(
          owner,
          McpImageUploadGetSchema.parse(args).uploadId,
          checked(guard),
        ),
    }),
    createMcpBatchTool({
      name: "carrot_get_image_upload",
      schema: McpImageUploadGetSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "Inspect an owned upload receipt, validated status, next byte offset and fixed expiry. Contains no image data, paths or credentials. Does not extend expiry or run validation/inference.",
      execute: async (args, owner, guard) =>
        store.inspect(
          owner,
          McpImageUploadGetSchema.parse(args).uploadId,
          checked(guard),
        ),
    }),
    createMcpBatchTool({
      name: "carrot_discard_image_upload",
      schema: McpImageUploadGetSchema,
      scopes,
      write: true,
      description:
        "Discard only an owned staging upload, including expired uploads. Refuses while in use. Already incorporated native images or block lettering and their recovery are not deleted. No arbitrary filesystem target.",
      execute: (args, owner, guard) =>
        store.discard(
          owner,
          McpImageUploadGetSchema.parse(args).uploadId,
          checked(guard),
        ),
    }),
  ].map((tool) => ({ ...tool, destructive: false }));
  return { store, tools, stop: () => store.stop(), close: () => store.close() };
}
