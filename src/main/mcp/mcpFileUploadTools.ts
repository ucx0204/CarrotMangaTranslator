import {
  McpFileUploadBeginSchema,
  McpFileUploadChunkSchema,
} from "../../shared/mcpFileUploads";
import { McpImageUploadGetSchema } from "../../shared/mcpImageUploads";
import { createMcpBatchTool } from "./mcpBatchTool";
import type { McpFileUploadStore } from "./mcpFileUploadStore";

/** File transfer is not an image-edit capability or a library publication. */
export function createMcpFileUploadTools(
  store: McpFileUploadStore,
  lifetime: AbortSignal,
  enabled: boolean,
) {
  const check = (guard: () => void) => () => {
    lifetime.throwIfAborted();
    guard();
  };
  const scopes = ["carrot.read", "carrot.edit", "carrot.process"];
  const tools = [
    createMcpBatchTool({
      name: "carrot_get_file_upload",
      schema: McpImageUploadGetSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "Inspect this connection's incoming-file receipt and exact next byte offset. Metadata only; no file bytes, paths or external fetch. Fixed thirty-minute session expiry. Ready verifies length/SHA-256, not format/importability. Server restart removes this temporary capability; imported chapters and their separate receipts remain.",
      execute: async (args, owner, guard) =>
        store.inspect(
          owner,
          McpImageUploadGetSchema.parse(args).uploadId,
          check(guard),
        ),
    }),
  ];
  if (enabled)
    tools.push(
      createMcpBatchTool({
        name: "carrot_begin_file_upload",
        schema: McpFileUploadBeginSchema,
        scopes,
        write: true,
        description:
          "Reserve an owned incoming image/ZIP/CBZ/PDF/RAR/CBR or .mgtshare working file, TXT/CSV/TSV review file or JSON context file: actual bytes and SHA-256 required. PNG/JPEG/WebP image filenames accepted. Maximum 4 MiB for TXT/CSV/TSV/JSON, 128 MiB for other admitted files; 16 files/256 MiB shared session, 256 request receipts, fixed thirty minutes. Display filename is untrusted data, not a PC path. No URL, opaque attachment handle, local file read, executable, automatic import, model or library change. Host must deliver real bytes through write_file_upload; naming a chat attachment is not transfer. After finishing, .mgtshare uses preview_work_file then import_work_file, not image-archive import. Text files use preview_text_file_import; context JSON uses preview_context_import. Each consumer separately validates format and reviewed native targets.",
        execute: (args, owner, guard) =>
          store.begin(owner, args, null, check(guard)),
      }),
      createMcpBatchTool({
        name: "carrot_write_file_upload",
        schema: McpFileUploadChunkSchema,
        scopes,
        write: true,
        description:
          "Append at most 32 KiB of actual file bytes as canonical base64 at receivedBytes; at most 4096 chunks/file. Exact retries are accepted; gaps, overlaps, changed retries and excess bytes are rejected. Only writes this owned staging file, never a native source or output. No file-reference/URL fetching.",
        execute: (args, owner, guard) => store.chunk(owner, args, check(guard)),
      }),
      createMcpBatchTool({
        name: "carrot_finish_file_upload",
        schema: McpImageUploadGetSchema,
        scopes,
        write: true,
        description:
          "Stream-check complete length and declared SHA-256 without buffering the whole container. Ready means bytes-verified only, not safe/importable/decoded. For images/containers use prepare_uploaded_import then import_chapters; for editable .mgtshare use preview_work_file then import_work_file and keep the upload until publication settles. TXT/CSV/TSV and context JSON require their dedicated preview/apply tools. Never parses, runs native preparation, imports or executes a model automatically.",
        execute: (args, owner, guard) =>
          store.finish(
            owner,
            McpImageUploadGetSchema.parse(args).uploadId,
            check(guard),
          ),
      }),
      createMcpBatchTool({
        name: "carrot_discard_file_upload",
        schema: McpImageUploadGetSchema,
        scopes,
        write: true,
        description:
          "Discard only an owned incoming staging file, including an expired one. Active transfer/validation/preparation leases prevent disposal. Frozen import previews, already imported chapters, original local files and retained receipts are not removed. Reusing a discarded reservation requestId does not recreate it.",
        execute: (args, owner, guard) =>
          store.discard(
            owner,
            McpImageUploadGetSchema.parse(args).uploadId,
            check(guard),
          ),
      }),
    );
  return tools.map((tool) => ({ ...tool, destructive: false }));
}
