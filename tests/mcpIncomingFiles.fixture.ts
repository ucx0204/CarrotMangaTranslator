import { createHash, randomUUID } from "node:crypto";
import { mcpFileUploadOutputs } from "../src/shared/mcpFileUploads";
import { McpImportPreviewReferenceSchema } from "../src/shared/mcpLibraryImport";
import type { libraryImportFixture } from "./mcpLibraryImport.fixture";

type Call = (name: string, args: object) => Promise<unknown>;
export async function receiveIncomingFile(
  call: Call,
  bytes: Buffer,
  filename = "받은 원고.png",
) {
  const begin = {
    requestId: randomUUID(),
    filename,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const first = mcpFileUploadOutputs.carrot_begin_file_upload.parse(
    await call("carrot_begin_file_upload", begin),
  );
  for (let offset = 0; offset < bytes.length; offset += first.chunkBytes)
    await call("carrot_write_file_upload", {
      uploadId: first.uploadId,
      offset,
      data: bytes
        .subarray(offset, offset + first.chunkBytes)
        .toString("base64"),
    });
  return mcpFileUploadOutputs.carrot_finish_file_upload.parse(
    await call("carrot_finish_file_upload", { uploadId: first.uploadId }),
  );
}
export async function prepareIncomingFile(
  f: Pick<
    Awaited<ReturnType<typeof libraryImportFixture>>,
    "invoke" | "settle"
  >,
  uploadId: string,
  kind: "images" | "archive" | "pdf" = "images",
) {
  const input = { requestId: randomUUID(), source: "local", kind, uploadId };
  const accepted = await f.invoke("carrot_prepare_uploaded_import", input);
  const done = await f.settle(accepted);
  if (done.status !== "completed") throw new Error(JSON.stringify(done));
  return {
    input,
    accepted,
    ref: McpImportPreviewReferenceSchema.parse(done.result?.importPreview),
  };
}
