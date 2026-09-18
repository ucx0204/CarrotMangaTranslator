import {
  McpFontListInput,
  McpTypographyPreflightInput,
} from "../../shared/mcpTypographyRead";
import type { McpTypographyReadService } from "../application/mcpTypographyReadService";
import { createMcpBatchTool } from "./mcpBatchTool";
import type { McpTool } from "./mcpReadTools";

export function createMcpTypographyReadTools(
  service: McpTypographyReadService,
): McpTool[] {
  return [
    createMcpBatchTool({
      name: "carrot_list_fonts",
      schema: McpFontListInput,
      description:
        "List app-registered built-in/custom fonts with inspected availability, base-face metadata and saved visibility preferences. Not an OS font inventory; no font files, paths, downloads, migration, models or edits. Keep the snapshot across pagination; changed inventory requires restarting. Locale is catalog/probe coverage, not a guarantee every glyph or style renders. Custom fonts are not automatically C23 candidates.",
      scopes: ["carrot.read"],
      write: false,
      execute: (input, _owner, guard) => service.listFonts(input, guard),
    }),
    createMcpBatchTool({
      name: "carrot_preflight_typography",
      schema: McpTypographyPreflightInput,
      description:
        "Inspect saved inputs for independent FONT/SIZE analysis in one chapter (1-50 pages, 1000 blocks). Infer IDs and requested language pair from the user task. No models, OCR, downloads, migration, writes or rendering. Reports exact ordered targets, revisions, exclusions, required stages and whether the analysis tool is connected. C23 font analysis requires explicit OCR permission; raster size measurement does not. Saved source measurements are not assumed fresh. inputs_available is NOT runtime readiness, reservation or a completed analysis; examine notChecked, analysisToolAvailable and analysisTool before attempting execution. Currently only one-page size measurement is connected; font and multi-page analysis are not.",
      scopes: ["carrot.read"],
      write: false,
      execute: (input, _owner, guard) => service.preflight(input, guard),
    }),
  ];
}
