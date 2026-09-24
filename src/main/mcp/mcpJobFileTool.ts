import { z } from "zod/v4";
import {
  mcpArtifactName,
  mcpArtifactRequiresImages,
} from "../../shared/mcpOutputFormats";
import type { McpOperationService } from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import { McpInvalidParams } from "./mcpArguments";
import { mcpJobFileOutput } from "./mcpJobOutputSchema";
import { textContent, type McpTool } from "./mcpReadTools";

const inputSchema = z
  .object({
    jobId: z.string().uuid(),
    pageId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional(),
    includeAttachment: z.boolean().optional(),
  })
  .strict();
type Access = {
  available: (url: string) => Promise<void>;
  allowImages: boolean;
  disclosed?: (url: string, attachment: boolean) => Promise<void>;
};

/** One owned output selector; actual content determines additional image authority. */
export function createMcpJobFileTool(
  operations: McpOperationService,
  access: Access,
): McpTool {
  return {
    name: "carrot_get_job_file",
    readOnly: true,
    destructive: false,
    idempotent: true,
    requiredScopes: ["carrot.read"],
    description:
      "Retrieve one expiring file from an owned settled export job. Select pageId for a page batch; omit it for single-page, ZIP, working-file, text or context jobs. Completed pages of partial/cancelled batches remain available while valid. Text/context requires read permission; image, PSD, ZIP and working files additionally require current image permission and redaction checks. Default returns text metadata and a link. Set includeAttachment=true only when a file attachment was requested. Availability, source bindings and authorization are rechecked. No render, serialization, archive packing or job starts. After restart or expiry, inspect retained output IDs and explicitly reissue unchanged bytes. A response or HTTP completion does not confirm client receipt.",
    inputSchema: z.toJSONSchema(inputSchema),
    invoke: async (args, context) => {
      const parsed = inputSchema.safeParse(args);
      if (!parsed.success) throw new McpInvalidParams();
      const artifact = await retrieveFile(
        operations,
        access,
        parsed.data,
        context,
      );
      const attachment = parsed.data.includeAttachment === true;
      await access.disclosed?.(artifact.url, attachment);
      assertFileAuthority(context, access.allowImages, artifact.mimeType);
      const content = textContent(artifact);
      if (!attachment) return content;
      return [
        ...content,
        {
          type: "resource_link",
          uri: artifact.url,
          name: `carrot-${mcpArtifactName(artifact.mimeType)}`,
          mimeType: artifact.mimeType,
          size: artifact.bytes,
        },
      ];
    },
  };
}

async function retrieveFile(
  operations: McpOperationService,
  access: Access,
  input: z.infer<typeof inputSchema>,
  context: Parameters<McpTool["invoke"]>[1],
) {
  const owner = assertFileAuthority(context, access.allowImages);
  await operations.ready();
  const value = operations.file(input.jobId, owner, input.pageId);
  const parsed = mcpJobFileOutput.safeParse({ jobId: input.jobId, ...value });
  if (!parsed.success || parsed.data.bytes <= 0)
    throw new McpEditError(
      "not_found",
      "Completed output metadata is unavailable.",
    );
  const artifact = parsed.data;
  assertFileAuthority(context, access.allowImages, artifact.mimeType);
  await access.available(artifact.url);
  assertFileAuthority(context, access.allowImages, artifact.mimeType);
  operations.file(input.jobId, owner, input.pageId);
  return artifact;
}

function assertFileAuthority(
  context: Parameters<McpTool["invoke"]>[1],
  images: boolean,
  mime?: Parameters<typeof mcpArtifactRequiresImages>[0],
) {
  context?.assertAuthorized();
  if (!context?.principalId || !context.assertScopes)
    throw new McpEditError(
      "access_denied",
      "An approved connection and output scope verification are required.",
    );
  const needsImages = mime !== undefined && mcpArtifactRequiresImages(mime);
  if (needsImages && !images)
    throw new McpEditError(
      "access_denied",
      "Image transfer is not enabled for this MCP session.",
    );
  context.assertScopes(
    needsImages ? ["carrot.read", "carrot.images"] : ["carrot.read"],
  );
  return context.principalId;
}
