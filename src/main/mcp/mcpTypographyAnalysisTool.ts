import { z } from "zod/v4";
import {
  McpTypographyAnalysisTargetSchema,
  type McpTypographyAnalysisTarget,
} from "../../shared/mcpTypographyAnalysis";
import type {
  McpOperationContext,
  McpOperationService,
} from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import { McpInvalidParams } from "./mcpArguments";
import { textContent, type McpTool } from "./mcpReadTools";

const scopes = ["carrot.read", "carrot.process"];
export function createMcpTypographyAnalysisTool(
  operations: McpOperationService,
  execute: (
    request: McpTypographyAnalysisTarget,
    context: McpOperationContext,
  ) => Promise<Record<string, unknown>>,
): McpTool {
  return {
    name: "carrot_run_typography_analysis",
    oauth: true,
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: true,
    requiredScopes: scopes,
    inputSchema: z.toJSONSchema(McpTypographyAnalysisTargetSchema),
    description:
      "Analyze explicit saved pages in ONE chapter using the existing source-size raster estimator and optional C23 source-font engine. Read carrot_preflight_typography first and retain its snapshot, catalogSnapshot and ordered page/revision pairs. Size mode never runs OCR or models. Font modes require Japanese-to-Korean inputs, allowOcr=true and allowAssetDownloads=true; the app may install approved Hayai/C23 assets. One shared local-model lease and one OCR CPU worker. No translation, erasure, rendering, page writes or font application. Choices are observations, not approved style changes; manual profile locks still require separate application checks. Poll carrot_get_job until terminal. Observations expire in 30 minutes or on restart. No images, font files, downloads links or attachments are returned. Failed jobs require a fresh preflight and new explicit request, not single-page retry.",
    invoke: async (args, context) => {
      const parsed = McpTypographyAnalysisTargetSchema.safeParse(args);
      if (!parsed.success) throw new McpInvalidParams();
      if (
        !context?.principalId ||
        !context.assertScopes ||
        !context.assertJobAuthorized
      )
        throw new McpEditError(
          "access_denied",
          "An approved processing connection is required.",
        );
      context.assertAuthorized();
      context.assertScopes(scopes);
      const assertJobAuthorized = context.assertJobAuthorized;
      return textContent(
        await operations.start({
          owner: context.principalId,
          kind: "typographyAnalysis",
          parameters: parsed.data,
          requestId: parsed.data.requestId,
          assertAuthorized: () => assertJobAuthorized(scopes),
          execute: (job) => execute(parsed.data, job),
        }),
      );
    },
  };
}
