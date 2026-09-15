import { z } from "zod";
import type { McpOperationService } from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpOperationExecutor } from "./mcpOperationTools";
import {
  allowArguments,
  readWindow,
  windowProperties,
  McpInvalidParams,
} from "./mcpArguments";
import { textContent, type McpTool } from "./mcpReadTools";

type Executors = {
  exportPng?: McpOperationExecutor;
  ocr?: McpOperationExecutor;
  erase?: McpOperationExecutor;
};
const retrySchema = z
  .object({
    jobId: z.string().uuid(),
    requestId: z.string().uuid(),
    revision: z.string().regex(/^page-v1:[a-f0-9]{16}$/),
  })
  .strict();

export function createMcpJobRecoveryTools(
  operations: McpOperationService,
  executors: Executors,
): McpTool[] {
  return [
    createListJobsTool(operations),
    createRetryJobTool(operations, executors),
  ];
}
function createListJobsTool(operations: McpOperationService): McpTool {
  return {
    name: "carrot_list_jobs",
    readOnly: true,
    requiredScopes: ["carrot.read"],
    description:
      "List this approved connection's retained jobs after reconnection or server restart. History lasts seven days. Interrupted jobs never resume automatically; inspect the saved page before retrying.",
    inputSchema: {
      type: "object",
      properties: windowProperties,
      additionalProperties: false,
    },
    invoke: async (args, context) => {
      allowArguments(args, ["offset", "limit"]);
      context?.assertAuthorized();
      if (!context?.principalId)
        throw new McpEditError(
          "access_denied",
          "An approved OAuth connection is required.",
        );
      await operations.ready();
      const window = readWindow(args);
      return textContent(
        operations.list(context.principalId, window.offset, window.limit),
      );
    },
  };
}
function createRetryJobTool(
  operations: McpOperationService,
  executors: Executors,
): McpTool {
  return {
    name: "carrot_retry_job",
    readOnly: false,
    destructive: true,
    idempotent: true,
    openWorld: true,
    requiredScopes: ["carrot.read"],
    description:
      "Explicitly retry a failed, cancelled or interrupted owned job. Supply a NEW requestId and its ORIGINAL revision after checking the current page. Refuses changed pages and completed jobs. Uses currently configured app engines, not a saved secret configuration. The job's original image/process scope is also mandatory. No automatic restart or rollback.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", format: "uuid" },
        requestId: { type: "string", format: "uuid" },
        revision: { type: "string", pattern: "^page-v1:[a-f0-9]{16}$" },
      },
      required: ["jobId", "requestId", "revision"],
      additionalProperties: false,
    },
    invoke: async (args, context) => {
      const parsed = retrySchema.safeParse(args);
      if (!parsed.success) throw new McpInvalidParams();
      context?.assertAuthorized();
      if (
        !context?.principalId ||
        !context.assertScopes ||
        !context.assertJobAuthorized
      )
        throw new McpEditError(
          "access_denied",
          "An approved OAuth connection is required for retries.",
        );
      await operations.ready();
      const { kind, target } = operations.retryTarget(
        parsed.data.jobId,
        context.principalId,
        parsed.data.revision,
      );
      const execute = executorFor(kind, executors);
      const scopes = [
        "carrot.read",
        kind === "exportPng" ? "carrot.images" : "carrot.process",
      ];
      context.assertScopes(scopes);
      if (target.requestId === parsed.data.requestId)
        throw new McpEditError(
          "invalid_edit",
          "Use a new requestId for a retry, not the original job requestId.",
        );
      const parameters = { ...target, requestId: parsed.data.requestId };
      return textContent(
        await operations.start({
          owner: context.principalId,
          requestId: parameters.requestId,
          kind,
          parameters,
          assertAuthorized: () => context.assertJobAuthorized?.(scopes),
          execute: (job) => execute(parameters, job),
        }),
      );
    },
  };
}
function executorFor(kind: string, executors: Executors): McpOperationExecutor {
  const execute =
    kind === "ocr"
      ? executors.ocr
      : kind === "erase"
        ? executors.erase
        : executors.exportPng;
  if (!execute)
    throw new McpEditError(
      "access_denied",
      "This operation is disabled in the app's current permissions.",
    );
  return execute;
}
