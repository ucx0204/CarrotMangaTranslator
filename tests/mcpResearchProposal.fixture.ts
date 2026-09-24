import { randomUUID } from "node:crypto";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";
import type { McpResearchPreparation } from "../src/main/application/mcpResearchProposalState";
import { contextMigrationAppFixture } from "./mcpContextMigrationApp.fixture";

export async function researchProposalFixture(clock = Date.now) {
  const f = await contextMigrationAppFixture();
  const { McpResearchProposalRepository } =
    await import("../src/main/mcp/mcpResearchProposalRepository");
  const { McpResearchProposalApplication } =
    await import("../src/main/mcp/mcpResearchProposalApplication");
  const { McpRetentionStorage } =
    await import("../src/main/mcp/mcpRetentionStorage");
  const storage = new McpRetentionStorage(f.codec, clock);
  let lifetime = new AbortController();
  const open = () => {
    const repository = new McpResearchProposalRepository(
      storage,
      lifetime.signal,
    );
    return {
      repository,
      application: new McpResearchProposalApplication(
        repository,
        f.app,
        f.editing,
        lifetime.signal,
      ),
    };
  };
  let current = open();
  const graph = await f.graph();
  const anchor = graph.chapters.find((item) => item.chapter.id === "chapter");
  if (!anchor) throw new Error("Missing fixture anchor");
  const input: McpResearchPreparation = {
    request: {
      chapterId: "chapter",
      requestId: randomUUID(),
      revision: mcpContextRevision({
        ...graph,
        storyMemory: anchor.storyMemory,
      }),
      changes: [
        {
          changeId: "term",
          entity: "glossary",
          values: { source: "Research term", target: "Reviewed name" },
        },
        {
          changeId: "unselected",
          entity: "character",
          values: { displayName: "Unselected character" },
        },
      ],
    },
    source: "external-research",
    evidence: [
      {
        changeId: "term",
        reason: "Reviewed source",
        sources: [{ title: "Source", url: "https://example.com/research" }],
      },
    ],
    warnings: ["Caller-supplied research is not verified page memory."],
  };
  const guard = () => {};
  return {
    ...f,
    input,
    guard,
    storage,
    prepare: (value = input) =>
      current.repository.prepare("migration-owner", value, guard),
    inspectReview: (proposalId: string, owner = "migration-owner") =>
      current.repository.inspect(
        owner,
        { proposalId, offset: 0, limit: 10 },
        guard,
      ),
    applyReview: (
      proposalId: string,
      selectedChangeIds = ["term"],
      requestId = randomUUID(),
    ) =>
      current.application.apply(
        "migration-owner",
        { proposalId, selectedChangeIds, requestId },
        guard,
      ),
    backend: () => current,
    reconstruct: async () => {
      lifetime.abort();
      await f.restart();
      lifetime = new AbortController();
      current = open();
    },
    close: async () => {
      lifetime.abort();
      await f.close();
    },
  };
}
