import {
  McpContextResearchTargetSchema,
  McpContextResearchResultSchema,
  type McpContextResearchTarget,
} from "../../shared/mcpContextEditing";
import type {
  ResearchWorkContextRequest,
  WorkContextResearchProposal,
} from "../../shared/workContextResearchTypes";
import {
  assertContextTarget,
  type McpContextSnapshot,
} from "./mcpContextEditPolicy";
import type { McpContextProposalService } from "./mcpContextProposalService";
import type { McpOperationContext } from "./mcpOperationService";
import { contextResearchChanges } from "./mcpContextResearchPolicy";
import { McpEditError } from "./mcpEditPolicy";

type Ports = {
  read: (chapterId: string) => Promise<McpContextSnapshot>;
  research: (
    request: ResearchWorkContextRequest,
    context: McpOperationContext,
  ) => Promise<WorkContextResearchProposal>;
  proposals: Pick<McpContextProposalService, "previewAppResearch">;
};

/** Research only returns review proposals. No direct context/page writes. */
export class McpContextResearchService {
  constructor(private readonly ports: Ports) {}

  async run(
    owner: string,
    input: McpContextResearchTarget,
    context: McpOperationContext,
  ) {
    const target = McpContextResearchTargetSchema.parse(input);
    context.assertAuthorized();
    const initial = await this.ports.read(target.chapterId);
    assertContextTarget(initial, target.chapterId, target.revision);
    context.assertAuthorized();
    const researched = await this.ports.research(
      {
        runId: context.id,
        chapterId: target.chapterId,
        researchTitle: target.researchTitle,
        engine: target.engine,
        guideSnapshot: structuredClone(initial.styleGuide),
      },
      context,
    );
    context.assertAuthorized();
    const current = await this.ports.read(target.chapterId);
    assertContextTarget(current, target.chapterId, target.revision);
    context.assertAuthorized();
    const changes = contextResearchChanges(initial.styleGuide, researched, {
      chapterId: target.chapterId,
      revision: target.revision,
      requestId: target.requestId,
    });
    const base = {
      chapterId: target.chapterId,
      revision: target.revision,
      engine: target.engine,
      performed: ["context-research"],
      pagesChanged: 0,
      needsReview: true,
    };
    if (!changes)
      return {
        ...base,
        status: "no_changes",
        queryCount: researched.stats.queryCount,
        sourceCount: researched.stats.sourceCount,
        tavilyCreditsUsed: researched.stats.tavilyCreditsUsed,
      };
    const warnings = [
      ...researched.warnings,
      "Research may use saved text across this work and contain spoilers. It never becomes page-read memory automatically.",
      "Inspect all proposed changes and sources. Existing entry provenance and omitted optional fields are preserved by the partial editor.",
    ];
    if (
      warnings.length > 100 ||
      warnings.some((warning) => warning.length > 2000)
    )
      throw new McpEditError(
        "invalid_edit",
        "Research warnings exceed the review budget; nothing was applied.",
      );
    const proposal = await this.ports.proposals.previewAppResearch(
      owner,
      changes.input,
      changes.evidence,
      warnings,
      context.assertAuthorized,
    );
    context.assertAuthorized();
    const result = McpContextResearchResultSchema.parse({
      ...proposal,
      queryCount: researched.stats.queryCount,
      sourceCount: researched.stats.sourceCount,
      tavilyCreditsUsed: researched.stats.tavilyCreditsUsed,
    });
    return {
      ...base,
      status: "proposed",
      proposalExpired: false,
      contextResearch: result,
    };
  }
}
