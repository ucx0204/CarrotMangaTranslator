import type { z } from "zod/v4";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  type mcpContextOutputSchemas,
  type McpContextApplySchema,
} from "../../shared/mcpContextEditing";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { withLibraryRead } from "../library/lock";
import { McpEditError } from "../application/mcpEditPolicy";
import { prepareRetainedResearchApplication } from "../application/mcpResearchProposalPolicy";
import type { RetainedResearchProposal } from "../application/mcpResearchProposalState";
import { McpContextMigrationApplication } from "./mcpContextMigrationApplication";
import { McpContextMigrationRepository } from "./mcpContextMigrationRepository";
import type { McpResearchProposalRepository } from "./mcpResearchProposalRepository";

type Input = z.infer<typeof McpContextApplySchema>;
type Receipt = z.infer<
  typeof mcpContextOutputSchemas.carrot_apply_context_proposal
>;
type Editing = ConstructorParameters<typeof McpContextMigrationApplication>[2];

/** Only catalog additions/partial updates use this path; references retain native IDs. */
export class McpResearchProposalApplication {
  constructor(
    private readonly repository: McpResearchProposalRepository,
    private readonly app: InpaintingJobContext,
    private readonly editing: Editing,
    private readonly lifetime: AbortSignal,
  ) {}

  async apply(
    owner: string,
    input: Input,
    guard: () => void,
  ): Promise<Receipt | undefined> {
    this.repository.check(guard);
    const record = await this.repository.optional(
      owner,
      input.proposalId,
      guard,
    );
    if (!record) return undefined;
    const replay = appliedResearchReceipt(record, input);
    if (replay) return replay;
    let preparedReceipt: Receipt | undefined;
    let publishedReceipt: Receipt | undefined;
    const recovery = new McpContextMigrationRepository(
      this.repository.storage,
      async (transaction, index, change) => {
        if (!preparedReceipt)
          throw new Error("Research application has no reviewed receipt.");
        // Final validation recomputes timestamps; return the receipt staged with the data.
        publishedReceipt = { ...preparedReceipt, recoveryId: change.id };
        await this.repository.applied(
          transaction,
          index,
          record,
          input,
          preparedReceipt,
          change.id,
          guard,
        );
      },
    );
    const application = new McpContextMigrationApplication(
      recovery,
      this.app,
      this.editing,
      this.lifetime,
    );
    const outcome = await application.applyIntent(
      owner,
      { ...input, chapterId: record.request.chapterId },
      guard,
      (graph, now, check) => {
        this.repository.assertLive(record);
        const prepared = prepareRetainedResearchApplication(
          graph,
          record,
          input,
          now,
          check,
        );
        preparedReceipt = prepared.receipt;
        return prepared;
      },
      "carrot_apply_context_proposal",
    );
    if (outcome.historical) {
      const current = await withLibraryRead(() =>
        this.repository.load(owner, input.proposalId),
      );
      const receipt = appliedResearchReceipt(current, input);
      if (!receipt)
        throw new Error("Committed research is missing its applied receipt.");
      return receipt;
    }
    if (!publishedReceipt)
      throw new Error("Committed research has no published receipt.");
    return publishedReceipt;
  }
}

function appliedResearchReceipt(
  record: RetainedResearchProposal,
  input: Input,
): Receipt | undefined {
  if (!record.applied) return undefined;
  if (hashStableValue(record.applied.input) !== hashStableValue(input))
    throw new McpEditError(
      "invalid_edit",
      "This research proposal was already applied. Retry only the identical application request.",
    );
  return {
    ...structuredClone(record.applied.receipt),
    status: "already_applied",
  };
}
