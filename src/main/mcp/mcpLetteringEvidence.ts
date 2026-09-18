import type { McpContextSnapshot } from "../application/mcpContextEditPolicy";
import type { LetteringBinding } from "../application/mcpLetteringPolicy";
import type { McpLetteringPrepare } from "../../shared/mcpLettering";
import { hashStableValue } from "../../shared/blockFingerprint";
import { parseRichText } from "../../shared/richTextMarkup";
import { requireBatchPage } from "../application/mcpPageBatchPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { hashMcpOriginalImage } from "./mcpTypographySourceEvidence";
import { readMcpFontCatalog } from "./mcpFontCatalogAdapter";
import { probePageExportSourceImage } from "../pageExportRasterSafety";
import type { MangaPage } from "../../shared/libraryTypes";

export async function captureMcpLetteringBinding(
  saved: McpContextSnapshot,
  input: Pick<McpLetteringPrepare, "command" | "pages">,
  guard: () => void,
) {
  guard();
  // Every selected page is a dependency, including model-free styling and wrapping.
  // On forward saves these revisions come from the plan's acknowledged commits.
  for (const target of input.pages) requireBatchPage(saved.chapter, target);
  const catalog =
    input.command.kind === "layout" ? null : await readMcpFontCatalog();
  guard();
  const images: LetteringBinding["images"] = [];
  if (input.command.kind === "layout" && input.command.mode !== "wrap") {
    for (const target of input.pages) {
      const page = requireBatchPage(saved.chapter, target);
      const paths = [
        page.imagePath,
        ...(page.inpaintedImagePath ? [page.inpaintedImagePath] : []),
      ];
      const hashes: string[] = [];
      for (const path of paths)
        hashes.push(await checkedImageHash(path, page, guard));
      images.push({
        pageId: page.id,
        sourceHash: hashes[0],
        cleanedHash: hashes[1] ?? null,
      });
    }
  }
  guard();
  return {
    binding: { images, catalogSnapshot: catalog?.snapshot ?? null },
    catalog,
  };
}
export function assertMcpLetteringBinding(
  before: LetteringBinding,
  after: LetteringBinding,
) {
  if (hashStableValue(before) !== hashStableValue(after))
    throw new McpEditError(
      "revision_conflict",
      "Lettering original, cleaned image or font catalog changed.",
    );
}
export function assertMcpLetteringFonts(
  before: MangaPage,
  after: MangaPage,
  catalog: Awaited<ReturnType<typeof readMcpFontCatalog>> | null,
) {
  if (!catalog) return;
  const available = new Set(
    catalog.fonts
      .filter((font) => font.availability === "available")
      .map((font) => font.fontId),
  );
  for (const [index, block] of after.blocks.entries()) {
    const previous = before.blocks[index];
    const priorInlineFonts = new Set(
      parseRichText(previous.translatedText).runs.map((run) => run.fontFamily),
    );
    const fonts = [
      ...(block.fontFamily !== previous.fontFamily && block.fontFamily
        ? [block.fontFamily]
        : []),
      ...parseRichText(block.translatedText)
        .runs.filter(
          (run) => run.fontFamily && !priorInlineFonts.has(run.fontFamily),
        )
        .map((run) => run.fontFamily),
    ];
    if (fonts.some((font) => !font || !available.has(font)))
      throw new McpEditError(
        "invalid_edit",
        "Requested lettering font is not available; no substitute font was applied.",
      );
  }
}

async function checkedImageHash(
  path: string,
  page: MangaPage,
  guard: () => void,
) {
  const dimensions = await probePageExportSourceImage(path);
  guard();
  if (dimensions.width !== page.width || dimensions.height !== page.height)
    throw new McpEditError(
      "revision_conflict",
      "Lettering source dimensions changed.",
    );
  return hashMcpOriginalImage(path, guard);
}
