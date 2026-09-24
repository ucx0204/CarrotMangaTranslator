import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { vi } from "vitest";
import { typographyAnalysisAppFixture } from "./mcpTypographyAnalysisApp.fixture";
import { mcpTestEncryption } from "./mcpEncryption.fixture";
import {
  McpImportCreateSchema,
  McpImportPreviewReferenceSchema,
  McpImportReceiptSchema,
  mcpLibraryImportOutputs,
} from "../src/shared/mcpLibraryImport";
import type { createMcpLibraryImportSession } from "../src/main/mcp/mcpLibraryImportSession";

type Native = NonNullable<Parameters<typeof createMcpLibraryImportSession>[1]>;
export async function libraryImportFixture(native: Native = {}) {
  const f = await typographyAnalysisAppFixture();
  const { McpSecureStore } = await import("../src/main/mcp/mcpSecureStore");
  const { McpRetentionStorage } =
    await import("../src/main/mcp/mcpRetentionStorage");
  const { McpOperationService } =
    await import("../src/main/application/mcpOperationService");
  const { createMcpLibraryImportSession } =
    await import("../src/main/mcp/mcpLibraryImportSession");
  const { createLibraryImportService } =
    await import("../src/main/library/libraryImportFacade");
  const { withLibraryMutation } = await import("../src/main/library/lock");
  const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
  const codec = new McpSecureStore(
    f.env.root,
    mcpTestEncryption(),
  ).retentionCodec();
  let now = Date.now();
  const storage = new McpRetentionStorage(codec, () => now);
  const inputDirectory = join(f.env.root, "authorized-input");
  await mkdir(inputDirectory);
  const originals = [
    join(inputDirectory, "first.png"),
    join(inputDirectory, "second.png"),
  ];
  await writeFile(originals[0], f.bytes);
  const second = PNG.sync.read(f.bytes);
  second.data.fill(128);
  await writeFile(originals[1], PNG.sync.write(second));
  const choose = vi.fn(async () => [...originals]);
  const validate = vi.fn(async (path: string) => {
    PNG.sync.read(await readFile(path));
  });
  const importer = createLibraryImportService({
    runMutation: withLibraryMutation,
    // Only the external native image decoder/validator is substituted. The real
    // importer, header/ZIP checks, filesystem and transaction publication execute.
    image: {
      validateImageFile: validate,
      convertWebpToPngFile: async () => {
        throw new Error("No WebP conversion in this PNG fixture");
      },
    },
  }).createImport;
  const errors: unknown[] = [];
  const failureDetails = (done: unknown) =>
    JSON.stringify({
      done,
      errors: errors.map((error) =>
        error instanceof Error ? error.stack : String(error),
      ),
    });
  let journal: unknown = null;
  const persistence = {
    load: async () => structuredClone(journal),
    save: async (value: unknown) => {
      journal = JSON.parse(JSON.stringify(value));
    },
  };
  const preferences = {
    allowEditing: true,
    allowProcessing: true,
    allowImages: false,
    autoStart: false,
  };
  const open = () => {
    const operations = new McpOperationService(
      (error) => errors.push(error),
      () => now,
      persistence,
    );
    const session = createMcpLibraryImportSession(
      {
        app: f.app,
        operations,
        storage,
        preferences,
        reportError: (error) => errors.push(error),
      },
      { choose, importer, ...native },
    );
    return { operations, session };
  };
  let current = open();
  const auth = (principalId = "import-owner", guard = () => {}) => ({
    principalId,
    assertAuthorized: guard,
    assertScopes: guard,
    assertJobAuthorized: guard,
  });
  const invoke = async (name: string, args: object, caller = auth()) => {
    const tool = current.session.tools.find((item) => item.name === name);
    if (!tool) throw new Error(`Missing import tool ${name}`);
    const result = mcpToolResult(
      tool,
      await tool.invoke(args as Record<string, unknown>, caller),
    );
    if (result.isError)
      throw new Error(JSON.stringify(result.structuredContent));
    return result.structuredContent;
  };
  const settle = async (value: unknown, owner = "import-owner") => {
    const id = (value as { jobId: string }).jobId;
    return current.operations.waitForCompletion(
      id,
      owner,
      new AbortController().signal,
    );
  };
  const prepare = async () => {
    const accepted = await invoke("carrot_choose_import_files", {
      source: "local",
      kind: "images",
      requestId: randomUUID(),
    });
    const done = await settle(accepted);
    if (done.status !== "completed") throw new Error(failureDetails(done));
    return McpImportPreviewReferenceSchema.parse(done.result?.importPreview);
  };
  const inspect = async (ref: Awaited<ReturnType<typeof prepare>>) =>
    mcpLibraryImportOutputs.carrot_get_import_preview.parse(
      await invoke("carrot_get_import_preview", {
        previewId: ref.previewId,
        snapshot: ref.snapshot,
      }),
    );
  const command = async (ref: Awaited<ReturnType<typeof prepare>>) => {
    const review = await inspect(ref);
    return McpImportCreateSchema.parse({
      previewId: ref.previewId,
      snapshot: ref.snapshot,
      requestId: randomUUID(),
      allowNativePreparation: true,
      target: { mode: "new", title: "Explicit new work" },
      chapters: [
        {
          draftId: review.pages[0].draftId,
          title: "Reviewed chapter",
          pageIds: review.pages.map((page) => page.pageId),
        },
      ],
    });
  };
  const create = async (
    input: Awaited<ReturnType<typeof command>>,
    caller = auth(),
  ) => {
    const done = await settle(
      await invoke("carrot_import_chapters", input, caller),
      caller.principalId,
    );
    if (done.status !== "completed") throw new Error(failureDetails(done));
    return McpImportReceiptSchema.parse(done.result?.importReceipt);
  };
  const closeCurrent = async () => {
    current.session.stop();
    current.operations.stop();
    await current.operations.close();
    await current.session.close();
  };
  return {
    ...f,
    storage,
    codec,
    choose,
    validate,
    originals,
    preferences,
    errors,
    persistence,
    auth,
    invoke,
    settle,
    prepare,
    inspect,
    command,
    create,
    importer,
    current: () => current,
    journal: () => journal,
    clock: (value: number) => {
      now = value;
    },
    restart: async () => {
      await closeCurrent();
      current = open();
      await current.operations.ready();
    },
    close: async () => {
      await closeCurrent();
      await f.close();
    },
  };
}
