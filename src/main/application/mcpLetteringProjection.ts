import { createConditionalBatchPreview } from "../../shared/conditionalBatchEngine";
import type { ConditionalBatchSchemeDraftV2 } from "../../shared/conditionalBatchRules";
import { McpFormatFieldsSchema } from "../../shared/mcpFormatEditing";
import {
  MCP_LETTERING_STYLE_KEYS,
  projectMcpLetteringState,
  type McpLetteringCommand,
} from "../../shared/mcpLettering";
import { hashStableValue } from "../../shared/blockFingerprint";
import { parseRichText } from "../../shared/richTextMarkup";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type { GlossaryEntry } from "../../shared/workContextTypes";
import { McpEditError } from "./mcpEditPolicy";
import { applyMcpBlockPatch } from "./mcpBlockEditPolicy";

export type McpLetteringRecipe = {
  schemes: ConditionalBatchSchemeDraftV2[];
  advanced?: Extract<McpLetteringCommand, { kind: "format" }>["advanced"];
};
const styleFields = new Set<string>([
  ...Object.keys(McpFormatFieldsSchema.shape),
  "outlineWidthScale",
  "textEffectEnabled",
  "textEffectColor",
  "textEffectOffsetX",
  "textEffectOffsetY",
  "textEffectBlur",
  "textEffectOpacity",
  "textGlowEnabled",
  "textGlowColor",
  "textGlowBlur",
  "textGlowOpacity",
]);
export function letteringSchemeIssues(
  scheme: ConditionalBatchSchemeDraftV2,
): string[] {
  return scheme.actions
    .filter((action) => action.enabled)
    .flatMap((action) => {
      if (action.type === "replaceText")
        return ["text_replacement_is_not_lettering"];
      if (action.type === "setFields")
        return action.changes
          .filter((change) => !styleFields.has(change.field))
          .map((change) => `non_lettering_field:${change.field}`);
      return [];
    });
}

export function projectMcpLetteringPage(options: {
  chapter: ChapterSnapshot;
  page: MangaPage;
  blockIds: string[];
  command: McpLetteringCommand;
  recipe: McpLetteringRecipe;
  glossary: readonly GlossaryEntry[];
}) {
  const { chapter, page, blockIds, command, recipe, glossary } = options;
  const issues = recipe.schemes.flatMap(letteringSchemeIssues);
  if (issues.length)
    throw new McpEditError(
      "invalid_edit",
      `Rule cannot be used for lettering: ${issues.join(", ")}.`,
    );
  let current = structuredClone(page);
  for (const scheme of recipe.schemes) {
    const context = {
      ...chapter,
      pages: chapter.pages.map((entry) =>
        entry.id === page.id ? current : entry,
      ),
    };
    const preview = createConditionalBatchPreview(
      context,
      { kind: "selection", pageId: page.id, blockIds },
      scheme,
      { glossary },
    );
    const results = new Map(
      preview.results.map((entry) => [entry.blockId, entry.afterBlock]),
    );
    current = {
      ...current,
      blocks: current.blocks.map((block) => results.get(block.id) ?? block),
    };
  }
  if (command.kind === "format" && Object.keys(command.fields).length) {
    const edits = blockIds.map((blockId) => ({
      blockId,
      fields: command.fields,
    }));
    current = {
      ...current,
      blocks: applyMcpBlockPatch(chapter, current, edits).blocks,
    };
  }
  const advanced =
    command.kind === "format" ? command.advanced : recipe.advanced;
  if (advanced) {
    const selected = new Set(blockIds);
    current = {
      ...current,
      blocks: current.blocks.map((block) =>
        selected.has(block.id) ? applyAdvanced(block, advanced) : block,
      ),
    };
  }
  return current;
}
function applyAdvanced(
  block: TranslationBlock,
  patch: NonNullable<McpLetteringRecipe["advanced"]>,
): TranslationBlock {
  const next = structuredClone(block);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key as keyof TranslationBlock];
    else Object.assign(next, { [key]: structuredClone(value) });
  }
  return next;
}
const geometryFields = ["renderBbox", "renderBboxSpace", "bubbleLayout"];
const sizeFields = ["fontSizePx", "fontSizeIntent", "autoFitText"] as const;
export function preserveMcpManualSize(
  before: TranslationBlock,
  after: TranslationBlock,
  preserve: boolean,
) {
  if (!preserve || before.fontSizeIntent !== "manual") return after;
  const next = structuredClone(after);
  for (const key of sizeFields) {
    if (Object.hasOwn(before, key)) Object.assign(next, { [key]: before[key] });
    else delete next[key];
  }
  // Inline-size changes are a separate explicit size modification, not a way around protection.
  if (
    hashStableValue(inlineSizes(before)) !== hashStableValue(inlineSizes(after))
  )
    return before;
  return next;
}
function inlineSizes(block: TranslationBlock) {
  return parseRichText(block.translatedText).runs.flatMap((run) =>
    Array.from(run.text).map((text) => [text, run.sizePx ?? null]),
  );
}
export function assertMcpLetteringOnly(
  before: TranslationBlock,
  after: TranslationBlock,
  command: McpLetteringCommand,
) {
  const layout = command.kind === "layout";
  const allowed = new Set(
    layout
      ? [...geometryFields, "translatedText", "renderDirection"]
      : MCP_LETTERING_STYLE_KEYS.filter((key) => !geometryFields.includes(key)),
  );
  const protectedState = (block: TranslationBlock) =>
    Object.fromEntries(
      Object.entries(block).filter(([key]) => !allowed.has(key)),
    );
  if (
    before.generatedLettering ||
    hashStableValue(protectedState(before)) !==
      hashStableValue(protectedState(after))
  )
    throw new McpEditError(
      "invalid_edit",
      "Lettering cannot replace source text, images, references, masks or unrequested properties.",
    );
  const beforeText = parseRichText(before.translatedText);
  const afterText = parseRichText(after.translatedText);
  if (layout) {
    const canWrap = command.mode !== "geometry";
    if (
      (!canWrap && before.translatedText !== after.translatedText) ||
      (canWrap &&
        hashStableValue(nonWhitespaceRuns(beforeText.runs)) !==
          hashStableValue(nonWhitespaceRuns(afterText.runs)))
    )
      throw new McpEditError(
        "invalid_edit",
        "Layout may only reflow whitespace; text and inline styles must remain unchanged.",
      );
  } else if (beforeText.plainText !== afterText.plainText) {
    throw new McpEditError(
      "invalid_edit",
      "Styling cannot replace visible translated text.",
    );
  }
  if (after.translatedText.length > 20000)
    throw new McpEditError(
      "invalid_edit",
      "Styled text exceeds the bounded review limit.",
    );
  projectMcpLetteringState(after);
}
function nonWhitespaceRuns(runs: ReturnType<typeof parseRichText>["runs"]) {
  return runs.flatMap(({ text, ...style }) =>
    Array.from(text)
      .filter((char) => !/\s/u.test(char))
      .map((char) => ({ char, ...style })),
  );
}
