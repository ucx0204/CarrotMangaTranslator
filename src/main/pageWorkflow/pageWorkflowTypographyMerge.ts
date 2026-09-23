import { workflowTypographyFields } from "../../shared/pageWorkflowPolicy";
import type { MangaPage } from "../../shared/libraryTypes";
import type { PageWorkflowPlan } from "../../shared/pageWorkflowTypes";
type Block = MangaPage["blocks"][number];

export function mergeWorkflowTypography(
  page: MangaPage,
  result: MangaPage,
  plan: PageWorkflowPlan,
): MangaPage {
  const byId = new Map(result.blocks.map((block) => [block.id, block]));
  const overwrite = plan.overwrite.includes("typography");
  return {
    ...page,
    blocks: page.blocks.map((block) => {
      const output = byId.get(block.id);
      if (!output) return block;
      const fields = workflowTypographyFields(block, plan);
      return {
        ...block,
        ...(fields.font ? workflowFontPatch(block, output, overwrite) : {}),
        ...(fields.size
          ? {
              fontSizePx: output.fontSizePx,
              fontSizeIntent: output.fontSizeIntent,
              sourceFontFacePx: output.sourceFontFacePx,
              sourceFontSizeConfidence: output.sourceFontSizeConfidence,
              sourceFontSizeMethod: output.sourceFontSizeMethod,
              autoFitText: output.autoFitText,
            }
          : {}),
        ...(block.workflowOrigin
          ? {
              workflowOrigin: {
                ...block.workflowOrigin,
                fontApplied: plan.autoFont || block.workflowOrigin.fontApplied,
                sizeApplied:
                  (fields.size && Boolean(output.sourceFontFacePx)) ||
                  block.workflowOrigin.sizeApplied,
              },
            }
          : {}),
      };
    }),
  };
}

function workflowFontPatch(
  block: Block,
  output: Block,
  overwrite: boolean,
): Partial<Block> {
  const initial = block.workflowOrigin?.initialFontStyle;
  const patch: Partial<Block> = { fontFamily: output.fontFamily };
  for (const key of [
    "bold",
    "italic",
    "fontWeight",
    "textColor",
    "outlineColor",
  ] as const) {
    if (
      overwrite ||
      block[key] === undefined ||
      (initial && block[key] === initial[key])
    )
      Object.assign(patch, { [key]: output[key] });
  }
  return patch;
}
