import { writeFile } from "node:fs/promises";
import { letteringAppFixture } from "./mcpLetteringApp.fixture";
import { createBlockStylePreset } from "../src/shared/blockStylePresets";
import { createBlockLibrarySaveInput } from "../src/shared/blockLibrary";
import type { BlockFormatGroupId } from "../src/shared/blockFormat";
import type { TranslationBlock } from "../src/shared/textTypes";
import type { McpLetteringResourceReference } from "../src/shared/mcpLetteringResources";

export async function letteringResourcesFixture() {
  const f = await letteringAppFixture();
  const { createMcpLetteringResources } =
    await import("../src/main/mcp/mcpLetteringResourcesAdapter");
  const { ConditionalBatchSchemeStore } =
    await import("../src/main/conditionalBatchSchemeStore");
  const { BlockLibraryStore } = await import("../src/main/blockLibraryStore");
  const resources = createMcpLetteringResources(f.app.appPaths);
  const rules = new ConditionalBatchSchemeStore(f.app.appPaths.dataRoot);
  const blocks = new BlockLibraryStore(f.app.appPaths.dataRoot);
  const source = (await f.library.openChapter("chapter")).pages[0];
  const reference = async (
    resourceKind: McpLetteringResourceReference["resourceKind"],
    id: string,
  ) => {
    const list = await resources.list({ resourceKind, query: id }, () => {});
    const entry = list.resources.find((item) => item.id === id);
    if (!entry) throw new Error("Fixture resource missing");
    return {
      kind: "resource" as const,
      resourceKind,
      id,
      snapshot: entry.snapshot,
    };
  };
  const preset = (
    id: string,
    name: string,
    groupIds: BlockFormatGroupId[],
    fields: Partial<TranslationBlock>,
  ) =>
    createBlockStylePreset({
      id,
      name,
      groupIds,
      block: { ...source.blocks[0], ...fields },
    });
  const setPresets = (presets: ReturnType<typeof preset>[]) =>
    writeFile(
      f.app.appPaths.settingsPath,
      JSON.stringify({
        blockStylePresets: presets,
        api: { apiKey: "PRIVATE_TEST_SECRET_NEVER_RETURN" },
        unrelated: "PRIVATE_TEST_SETTING",
      }),
    );
  const addBlockStyle = async (fields: Partial<TranslationBlock> = {}) => {
    const block = {
      ...source.blocks[0],
      ...fields,
      sourceText: "PRIVATE_TEMPLATE_SOURCE",
      translatedText: "PRIVATE_TEMPLATE_TRANSLATION",
    };
    const saved = await blocks.save(
      createBlockLibrarySaveInput(block, source, "Reusable style"),
    );
    return saved.entries[0];
  };
  return {
    ...f,
    resources,
    rules,
    blocks,
    source,
    reference,
    preset,
    setPresets,
    addBlockStyle,
  };
}
