import {
  McpLetteringResourceListSchema,
  McpLetteringResourceGetSchema,
} from "../../shared/mcpLetteringResources";
import type { McpLetteringResourceService } from "../application/mcpLetteringResourceService";
import { createMcpBatchTool } from "./mcpBatchTool";

export function createMcpLetteringResourceTools(
  resources: McpLetteringResourceService,
) {
  return [
    createMcpBatchTool({
      name: "carrot_list_lettering_resources",
      schema: McpLetteringResourceListSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "List the existing app's saved preset, rule, sequence or block-style resources by literal name/ID search. Read-only: no installation, models, artwork changes or usage-counter writes. The list snapshot is required on later pages; each item has a distinct snapshot for get/prepare. Unsupported text-replacement/reference actions are marked and never silently skipped. No block text, image/font bytes, local paths or global settings are returned. Rule definitions may contain user-authored pattern text.",
      execute: (input, _owner, guard) => resources.list(input, guard),
    }),
    createMcpBatchTool({
      name: "carrot_get_lettering_resource",
      schema: McpLetteringResourceGetSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "Inspect one saved lettering resource at its exact item snapshot. Returns native preset format as formatJson, supported field groupIds, optional block-style transforms and up to five enabled native rule drafts as schemeJson per page. Sequence order and referenced enabled rules are bound together. Oversized rules are marked unsupported and their JSON is withheld. A block-library entry contributes style only, not text, rectangles or generated artwork. Use carrot_prepare_lettering_batch command kind=resource with resourceKind/id/snapshot and optional stored groupIds; this read never applies or alters resources.",
      execute: (input, _owner, guard) => resources.get(input, guard),
    }),
  ];
}
