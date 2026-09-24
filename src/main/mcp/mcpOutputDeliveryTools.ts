import { McpGetOutputDeliverySchema } from "../../shared/mcpOutputDelivery";
import type { McpOutputDeliveryService } from "../application/mcpOutputDeliveryPolicy";
import { createMcpBatchTool } from "./mcpBatchTool";

export function createMcpOutputDeliveryTools(
  service: McpOutputDeliveryService,
) {
  return [
    createMcpBatchTool({
      name: "carrot_get_output_delivery",
      schema: McpGetOutputDeliverySchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "Inspect delivery evidence for one owned job/page, retained output or output-sync receipt. Reports generation, checked retention/access, current-session capability and tool-response preparation, observed HTTP transfer and recorded destination publication separately. A successful HTTP response or resource link never proves the client displayed or saved a file: clientReceipt is always unconfirmed. No URL/path input, file bytes, attachment creation, link reissue, export, synchronization, receipt mutation or automatic retry. Missing session observations do not mean no prior transfer occurred.",
      execute: (args, owner, guard, assertAdditionalScopes) =>
        service.inspect(
          owner,
          McpGetOutputDeliverySchema.parse(args),
          guard,
          assertAdditionalScopes,
        ),
    }),
  ];
}
