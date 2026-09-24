import type { McpCompositeWorkflowService } from "../application/mcpCompositeWorkflowService";
import type {
  McpCompositeGuard,
  McpCompositeRecord,
} from "../application/mcpCompositeWorkflowPorts";
import type {
  McpCompositeImportPreflight,
  McpCompositeImportedTargets,
} from "../../shared/mcpCompositeWorkflow";
import type { McpCompositeRenderEvidence } from "../../shared/mcpCompositeWorkflowReview";
import type { inspectMcpCompositeMetadata } from "../application/mcpCompositeMetadataReview";

export type McpCompositeToolPort = {
  service: McpCompositeWorkflowService;
  list: (
    owner: string,
    guard: McpCompositeGuard,
  ) => Promise<McpCompositeRecord[]>;
  discard: (
    owner: string,
    id: string,
    guard: McpCompositeGuard,
  ) => Promise<unknown>;
  inspectMetadata: (
    record: McpCompositeRecord,
    input: { offset: number; limit: number; snapshot?: string },
    guard: McpCompositeGuard,
  ) => ReturnType<typeof inspectMcpCompositeMetadata>;
  importPreflight: (
    owner: string,
    input: McpCompositeImportPreflight,
    guard: McpCompositeGuard,
  ) => Promise<McpCompositeImportedTargets>;
  readEvidence: (
    record: McpCompositeRecord,
    evidenceId: string,
    guard: McpCompositeGuard,
  ) => Promise<{
    evidence: McpCompositeRenderEvidence;
    bytes: Buffer;
  }>;
};
