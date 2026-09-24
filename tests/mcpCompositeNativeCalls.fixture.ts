import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { McpCompositeNativeCalls } from "../src/main/mcp/mcpCompositeNativeCalls";
import { compositeNativeReference } from "../src/main/mcp/mcpCompositeNativeDispatch";
import {
  compositeFingerprint,
  zeroCompositeCost,
} from "../src/main/application/mcpCompositeWorkflowPolicy";
import type { McpCompositeBinding } from "../src/main/application/mcpCompositeWorkflowPorts";
import type { McpTool } from "../src/main/mcp/mcpReadTools";
import { McpCompositeWorkflowActionSchema } from "../src/shared/mcpCompositeWorkflowActions";
import { newCompositeRecord } from "./mcpCompositeRepository.fixture";
import { deferred } from "./mcpCompositeWorkflow.fixture";

export function compositeNativeCallsFixture(
  options: { wrongReceipt?: boolean } = {},
) {
  const record = newCompositeRecord();
  const action = McpCompositeWorkflowActionSchema.parse({
    kind: "images-export",
    input: {
      chapterId: "chapter",
      snapshot: "a".repeat(16),
      pages: [{ pageId: "page", revision: `page-v1:${"a".repeat(16)}` }],
      requestId: randomUUID(),
    },
  });
  const binding: McpCompositeBinding = {
    owner: record.owner,
    compositeId: record.id,
    phaseId: "output",
    action,
    family: action.kind,
    inputFingerprint: compositeFingerprint(action.input),
    nativeRequestId: action.input.requestId,
    nativeReference: compositeNativeReference(action),
    snapshot: record.snapshot,
    predecessorReceipts: [],
    cost: { ...zeroCompositeCost(), admissions: 1, pageAttempts: 1 },
  };
  const entered = deferred();
  const release = deferred();
  const cancelled = deferred();
  const errors: unknown[] = [];
  const operations = new McpOperationService((error) => errors.push(error));
  let executionSignal: AbortSignal | undefined;
  const execute = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
    executionSignal = signal;
    signal.addEventListener("abort", cancelled.resolve, { once: true });
    entered.resolve();
    await release.promise;
    signal.throwIfAborted();
    return { status: "saved" };
  });
  const tool: McpTool = {
    name: "carrot_export_pages_png",
    description: "Owned job admission fixture",
    inputSchema: {},
    requiredScopes: ["carrot.read", "carrot.images"],
    invoke: async (input, context) => {
      const result = await operations.start({
        owner: context?.principalId ?? "missing-owner",
        kind: "exportPages",
        requestId: String(input.requestId),
        parameters: input,
        execute,
        assertAuthorized: () => context?.assertAuthorized(),
      });
      await entered.promise;
      return [
        {
          type: "text",
          text: JSON.stringify(
            options.wrongReceipt ? { ...result, jobId: randomUUID() } : result,
          ),
        },
      ];
    },
  };
  const calls = new McpCompositeNativeCalls({
    operations,
    tools: [tool],
    batches: {},
  });
  return {
    binding,
    entered,
    release,
    cancelled,
    operations,
    calls,
    execute,
    errors,
    executionSignal: () => executionSignal,
    close: async () => {
      release.resolve();
      await operations.close();
    },
  };
}
