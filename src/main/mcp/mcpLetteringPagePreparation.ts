import { matchesMcpFormat } from "../../shared/mcpFormatEditing";
import { parseMcpLetteringRule } from "../../shared/mcpLetteringAdvanced";
import type { McpLetteringPrepare } from "../../shared/mcpLettering";
import type { LetteringPreparation } from "../application/mcpLetteringPolicy";
import {
  projectMcpLetteringPage,
  letteringSchemeIssues,
} from "../application/mcpLetteringProjection";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  prepareMcpLetteringLayout,
  mcpLayoutExclusion,
} from "./mcpLetteringLayout";
import { assertMcpLetteringFonts } from "./mcpLetteringEvidence";
import type { BubbleLayoutRunner } from "../inpainting/bubbleLayoutRunner";
import type { MangaPage } from "../../shared/libraryTypes";

type Saved = Parameters<LetteringPreparation>[0];
type Access = Parameters<LetteringPreparation>[2];
export function resolveMcpLetteringRecipe(input: McpLetteringPrepare) {
  if (input.command.kind !== "rule") return { schemes: [] };
  const scheme = parseMcpLetteringRule(input.command.schemeJson);
  if (letteringSchemeIssues(scheme).length)
    throw new McpEditError(
      "invalid_edit",
      "Only typography actions are allowed; no text replacement or reference edits.",
    );
  return { schemes: [scheme] };
}
export async function prepareMcpLetteringPages(
  saved: Saved,
  input: McpLetteringPrepare,
  access: Access,
  recipe: ReturnType<typeof resolveMcpLetteringRecipe>,
  catalog: Parameters<typeof assertMcpLetteringFonts>[2],
  runner?: BubbleLayoutRunner,
) {
  const signal = access.signal ?? new AbortController().signal;
  const pages: MangaPage[] = [];
  const exclusions: Record<string, Record<string, string>> = {};
  for (const target of input.pages) {
    access.guard();
    signal.throwIfAborted();
    const page = saved.chapter.pages.find((item) => item.id === target.pageId);
    if (!page) throw new McpEditError("not_found", "Lettering page missing.");
    const selected = selectTargets(page, target, input.command);
    exclusions[page.id] = selected.excluded;
    const next =
      input.command.kind === "layout"
        ? await prepareMcpLetteringLayout(
            page,
            selected.ids,
            input.command,
            signal,
            runner,
          )
        : projectMcpLetteringPage({
            chapter: saved.chapter,
            page,
            blockIds: selected.ids,
            command: input.command,
            recipe,
            glossary: saved.styleGuide.glossary,
          });
    assertMcpLetteringFonts(page, next, catalog);
    pages.push(next);
  }
  return { pages, exclusions };
}
function selectTargets(
  page: MangaPage,
  target: McpLetteringPrepare["pages"][number],
  command: McpLetteringPrepare["command"],
) {
  const excluded: Record<string, string> = {};
  const ids = target.edits
    .map((edit) => edit.blockId)
    .filter((id) => {
      const block = page.blocks.find((item) => item.id === id);
      if (!block)
        throw new McpEditError("not_found", "Lettering block missing.");
      const reason =
        command.kind === "layout"
          ? mcpLayoutExclusion(block, command)
          : block.generatedLettering
            ? "generated_lettering"
            : null;
      if (reason) {
        excluded[id] = reason;
        return false;
      }
      if (
        command.kind === "format" &&
        !matchesMcpFormat(page, block, command.filter)
      ) {
        excluded[id] = "format_filter_not_matched";
        return false;
      }
      return true;
    });
  return { ids, excluded };
}
