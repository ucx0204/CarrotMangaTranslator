import type { MangaPage } from "../../shared/libraryTypes";
import type { McpSoundEffectPrepare } from "../../shared/mcpSoundEffects";
import { McpEditError } from "./mcpEditPolicy";

/** Sound-effect fields only. Moderation flags are never cleared by remote edits. */
export function editSoundEffectBlocks(
  page: MangaPage,
  input: McpSoundEffectPrepare,
): MangaPage {
  const command = input.command;
  if (command.kind !== "text" && command.kind !== "image-state")
    throw new McpEditError(
      "invalid_edit",
      "Expected sound-effect text or image state.",
    );
  const ids =
    command.kind === "text"
      ? command.edits.map((edit) => edit.blockId)
      : command.blockIds;
  if (new Set(ids).size !== ids.length)
    throw new McpEditError(
      "invalid_edit",
      "Sound-effect block targets must be unique.",
    );
  for (const id of ids)
    if (
      page.blocks.filter(
        (block) => block.id === id && block.textRole === "sound",
      ).length !== 1
    )
      throw new McpEditError(
        "not_found",
        "Every target must be one saved sound-effect block, not dialogue.",
      );
  const blocks = page.blocks.map((block) => {
    if (!ids.includes(block.id)) return block;
    if (command.kind === "text") return applyText(block, command);
    const next = structuredClone(block);
    if (!next.generatedLettering) return next;
    if (command.state === "remove") delete next.generatedLettering;
    else {
      if (
        command.state === "enable" &&
        (next.imageGenerationBlocked ||
          next.generatedLettering.sourceText !== next.sourceText ||
          next.generatedLettering.translatedText !== next.translatedText)
      )
        throw new McpEditError(
          "invalid_edit",
          "Blocked or stale artwork cannot be enabled. Review the text and use an approved replacement.",
        );
      next.generatedLettering.enabled = command.state === "enable";
    }
    return next;
  });
  return { ...page, blocks };
}

function applyText(
  block: MangaPage["blocks"][number],
  command: Extract<McpSoundEffectPrepare["command"], { kind: "text" }>,
) {
  const edit = command.edits.find((edit) => edit.blockId === block.id);
  if (!edit) return block;
  if (edit.sourceText !== undefined && !edit.sourceText.trim())
    throw new McpEditError(
      "invalid_edit",
      "Empty source text cannot erase the approved reading.",
    );
  return {
    ...block,
    ...(edit.sourceText === undefined ? {} : { sourceText: edit.sourceText }),
    ...(edit.translatedText === undefined
      ? {}
      : { translatedText: edit.translatedText }),
  };
}
