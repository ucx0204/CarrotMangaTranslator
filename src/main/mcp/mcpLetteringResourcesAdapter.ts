import type { AppPaths } from "../appPaths";
import { getAppSettings } from "../settingsStore";
import { ConditionalBatchSchemeStore } from "../conditionalBatchSchemeStore";
import { BlockLibraryStore } from "../blockLibraryStore";
import {
  McpLetteringResourceService,
  type McpSavedLetteringResource,
} from "../application/mcpLetteringResourceService";
import { ALL_BLOCK_FORMAT_GROUP_IDS } from "../../shared/blockFormat";
import {
  normalizePresetFormat,
  buildBlockStylePresetFormat,
} from "../../shared/blockStylePresetFormat";
import {
  instantiateBlockLibraryEntry,
  type BlockLibraryEntryV1,
} from "../../shared/blockLibrary";
import {
  ConditionalBatchSchemeDraftV2Schema,
  type ConditionalBatchSchemeDraftV2,
} from "../../shared/conditionalBatchRules";
import { McpLetteringAdvancedSchema } from "../../shared/mcpLetteringAdvanced";

/** Uses the app stores' read methods only. No use()/save(), downloads or settings mutation. */
export function createMcpLetteringResources(paths: AppPaths) {
  const rules = new ConditionalBatchSchemeStore(paths.dataRoot);
  const blocks = new BlockLibraryStore(paths.dataRoot);
  return new McpLetteringResourceService(async (kind) => {
    if (kind === "preset")
      return (await getAppSettings(paths)).blockStylePresets.map((entry) => ({
        id: entry.id,
        name: entry.name,
        groupIds: [...entry.groupIds],
        format: normalizePresetFormat(entry.format, entry.groupIds),
        advanced: {},
        schemes: [],
        dependencies: [],
        unsupportedReasons: [],
      }));
    if (kind === "block-style")
      return (await blocks.list()).entries.map(blockStyle);
    const snapshot = await rules.list();
    if (kind === "rule")
      return snapshot.schemes.map((entry) =>
        ruleResource(entry.id, entry.name, [entry]),
      );
    return snapshot.sequences.map((sequence) => {
      const schemes = sequence.steps
        .filter((step) => step.enabled)
        .map((step) =>
          snapshot.schemes.find((rule) => rule.id === step.schemeId),
        );
      const existing = schemes.filter((scheme) => scheme !== undefined);
      const entry = ruleResource(sequence.id, sequence.name, existing);
      entry.dependencies = sequence.steps.map(({ id, schemeId, enabled }) => ({
        id,
        schemeId,
        enabled,
      }));
      if (existing.length !== schemes.length)
        entry.unsupportedReasons.push("missing_sequence_rule");
      if (!existing.length)
        entry.unsupportedReasons.push("no_enabled_sequence_steps");
      return entry;
    });
  });
}
function ruleResource(
  id: string,
  name: string,
  values: ConditionalBatchSchemeDraftV2[],
): McpSavedLetteringResource {
  return {
    id,
    name,
    groupIds: [],
    format: null,
    advanced: {},
    dependencies: [],
    unsupportedReasons: [],
    schemes: values.map(({ name, description, match, actions }) =>
      ConditionalBatchSchemeDraftV2Schema.parse({
        name,
        description,
        match,
        actions,
      }),
    ),
  };
}
function blockStyle(entry: BlockLibraryEntryV1): McpSavedLetteringResource {
  const base = {
    id: entry.id,
    name: entry.name,
    schemes: [],
    dependencies: [],
  };
  if (entry.block.generatedLettering)
    return {
      ...base,
      groupIds: [],
      format: null,
      advanced: {},
      unsupportedReasons: ["generated_lettering_template"],
    };
  // Instantiate through the native template contract, but project ONLY reusable style.
  // Text, source/display rectangles, references and pixels never leave this function.
  const block = instantiateBlockLibraryEntry(entry, "mcp-style-projection");
  return {
    ...base,
    groupIds: [...ALL_BLOCK_FORMAT_GROUP_IDS],
    format: buildBlockStylePresetFormat(block, ALL_BLOCK_FORMAT_GROUP_IDS),
    advanced: McpLetteringAdvancedSchema.parse({
      ...(block.perspectiveTransform
        ? { perspectiveTransform: block.perspectiveTransform }
        : {}),
      ...(block.warpTransform ? { warpTransform: block.warpTransform } : {}),
      ...(block.curveLayout ? { curveLayout: block.curveLayout } : {}),
    }),
    unsupportedReasons: [],
  };
}
