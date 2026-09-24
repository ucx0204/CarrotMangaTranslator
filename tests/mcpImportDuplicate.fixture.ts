import { randomUUID } from "node:crypto";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";
import { importWebBoundary } from "./mcpLibraryImportWeb.fixture";
import {
  McpImportPreviewReferenceSchema,
  mcpLibraryImportOutputs,
  type McpImportCreate,
} from "../src/shared/mcpLibraryImport";
import { mcpImportDuplicateOutputs } from "../src/shared/mcpImportDuplicates";

export async function importDuplicateFixture() {
  let paths: string[] = [];
  const web = importWebBoundary(() => paths);
  const f = await libraryImportFixture({ web });
  paths = f.originals;
  const target = async (workId: string) => {
    const view = mcpLibraryImportOutputs.carrot_get_import_target.parse(
      await f.invoke("carrot_get_import_target", { workId }),
    );
    return { mode: "existing" as const, workId, snapshot: view.snapshot };
  };
  const scan = async (url: string) => {
    const done = await f.settle(
      await f.invoke("carrot_scan_import_url", {
        requestId: randomUUID(),
        source: "web",
        url,
        allowNetwork: true,
      }),
    );
    if (done.status !== "completed") throw new Error(JSON.stringify(done));
    return f.command(
      McpImportPreviewReferenceSchema.parse(done.result?.importPreview),
    );
  };
  const review = (input: McpImportCreate, caller = f.auth()) =>
    f
      .invoke(
        "carrot_get_import_duplicates",
        {
          previewId: input.previewId,
          snapshot: input.snapshot,
          target: input.target,
          chapters: input.chapters,
        },
        caller,
      )
      .then((value) =>
        mcpImportDuplicateOutputs.carrot_get_import_duplicates.parse(value),
      );
  return { ...f, web, target, scan, review };
}
