import { randomUUID } from "node:crypto";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";
import { importWebBoundary } from "./mcpLibraryImportWeb.fixture";
import {
  McpImportBatchPrepareSchema,
  McpImportBatchRunSchema,
  mcpImportBatchOutputs,
} from "../src/shared/mcpImportBatch";

export async function importBatchFixture(count = 3) {
  let paths: string[] = [];
  const web = importWebBoundary(() => paths);
  const f = await libraryImportFixture({ web });
  paths = f.originals;
  const input = McpImportBatchPrepareSchema.parse({
    requestId: randomUUID(),
    sources: Array.from({ length: count }, (_, index) => ({
      kind: "url",
      url: `https://example.com/chapter/${index + 1}`,
      label: `Chapter ${index + 1}`,
    })),
  });
  const get = async (id: string, caller = f.auth()) =>
    mcpImportBatchOutputs.carrot_get_import_batch.parse(
      await f.invoke("carrot_get_import_batch", { id }, caller),
    );
  const prepare = async (value = input) =>
    mcpImportBatchOutputs.carrot_prepare_import_batch.parse(
      await f.invoke("carrot_prepare_import_batch", value),
    );
  const command = async (
    id: string,
    options: Partial<ReturnType<typeof McpImportBatchRunSchema.parse>> = {},
  ) =>
    McpImportBatchRunSchema.parse({
      id,
      version: (await get(id)).version,
      requestId: randomUUID(),
      allowNetwork: true,
      ...options,
    });
  const run = async (
    id: string,
    options: Partial<ReturnType<typeof McpImportBatchRunSchema.parse>> = {},
  ) => {
    const request = await command(id, options);
    const accepted = await f.invoke("carrot_run_import_batch", request);
    return {
      request,
      accepted,
      done: await f.settle(accepted),
      view: await get(id),
    };
  };
  return {
    ...f,
    web,
    input,
    get,
    prepareBatch: prepare,
    batchCommand: command,
    run,
  };
}
