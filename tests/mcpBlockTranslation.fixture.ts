import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { vi } from "vitest";
import type { translateMcpBlock } from "../src/main/mcp/mcpBlockTranslationAdapter";
import { recoveryLibrary } from "./mcpErasureRecovery.fixture";

type Runtime = NonNullable<Parameters<typeof translateMcpBlock>[3]>;
export async function translationFixture() {
  const f = await recoveryLibrary();
  const { getAppPaths } = await import("../src/main/appPaths");
  const { getAppSettings } = await import("../src/main/settingsStore");
  const { buildBaseOptions } = await import("../src/main/pipeline/options");
  const { prepareMcpBlockTranslationOptions } =
    await import("../src/main/mcp/mcpBlockTranslationOptions");
  const { translateMcpBlock } =
    await import("../src/main/mcp/mcpBlockTranslationAdapter");
  const { readMcpBlockTranslationContext } =
    await import("../src/main/mcp/mcpBlockTranslationContext");
  const { loadRuntimeModuleFromDirectory } =
    await import("../src/main/runtimeModuleLoader");
  const paths = getAppPaths();
  const base = buildBaseOptions(
    "fixture",
    join(f.environment.root, "run"),
    await getAppSettings(paths),
    paths,
    {},
  );
  const options = prepareMcpBlockTranslationOptions({
    ...base,
    modelProvider: "openai-api",
    apiBaseUrl: "https://translation.example.test/v1",
    apiModel: "fixture-model",
    apiKey: "first-key\nsecond-key",
    apiExtraBodyJson: "",
    maxTokens: 4096,
    ctx: 32768,
  }).options;
  const session = {
    handle: {
      provider: "openai-api" as const,
      child: null,
      startedByScript: false as const,
      baseUrl: options.apiBaseUrl,
    },
    dispose: vi.fn(async () => {}),
  };
  const runtime: Runtime = {
    start: vi.fn<Runtime["start"]>(async () => session),
    request: vi.fn<Runtime["request"]>(async () =>
      JSON.stringify({
        blockId: "a",
        translatedText: "translated\n\ud83e\udd55",
      }),
    ),
    readContext: (input, settings) =>
      readMcpBlockTranslationContext(input, settings, (id) =>
        loadRuntimeModuleFromDirectory(
          join(process.cwd(), "src/main/runtime"),
          id,
        ),
      ),
  };
  const input = {
    chapterId: "chapter",
    workId: "work",
    pageId: "page",
    pageIndex: 0,
    previousPageIds: [] as string[],
    blockId: "a",
    sourceText: "source",
    textRole: "ordinary" as const,
    contextMode: "saved" as const,
  };
  const controller = new AbortController();
  const operation = {
    id: randomUUID(),
    signal: controller.signal,
    progress: vi.fn(),
    assertAuthorized: vi.fn(() => controller.signal.throwIfAborted()),
  };
  return {
    ...f,
    options,
    base,
    session,
    runtime,
    input,
    controller,
    operation,
    prepare: prepareMcpBlockTranslationOptions,
    run: () => translateMcpBlock(input, options, operation, runtime),
  };
}
