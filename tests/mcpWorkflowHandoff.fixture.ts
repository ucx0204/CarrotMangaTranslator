import { randomUUID } from "node:crypto";
import { workflowFixture } from "./mcpWorkflow.fixture";
import { mcpWorkflowOutputs } from "../src/shared/mcpWorkflow";
import {
  mcpWorkflowHandoffOutputs,
  type McpWorkflowHandoffAccept,
} from "../src/shared/mcpWorkflowHandoff";

/** Uses the production workflow composition and actual isolated encrypted storage. */
export async function workflowHandoffFixture() {
  const f = await workflowFixture();
  const donor = f.auth();
  const recipient = f.auth("workflow-recipient");
  const inspect = async (id: string, caller = donor) =>
    mcpWorkflowOutputs.carrot_get_workflow.parse(
      await f.invoke("carrot_get_workflow", { id }, caller),
    );
  const offer = async (
    id: string,
    targetConnectionId = recipient.principalId,
    caller = donor,
  ) => {
    const record = await inspect(id, caller);
    const input = {
      id,
      version: record.version,
      requestId: randomUUID(),
      targetConnectionId,
    };
    const receipt =
      mcpWorkflowHandoffOutputs.carrot_offer_workflow_handoff.parse(
        await f.invoke("carrot_offer_workflow_handoff", input, caller),
      );
    const acceptance: McpWorkflowHandoffAccept = {
      id,
      offerId: receipt.offerId,
      version: receipt.version,
      requestId: randomUUID(),
    };
    return { input, receipt, acceptance };
  };
  const accept = async (input: McpWorkflowHandoffAccept, caller = recipient) =>
    mcpWorkflowHandoffOutputs.carrot_accept_workflow_handoff.parse(
      await f.invoke("carrot_accept_workflow_handoff", input, caller),
    );
  return { ...f, donor, recipient, inspect, offer, accept };
}
