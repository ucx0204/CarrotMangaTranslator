import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { contextMigrationAppFixture } from "./mcpContextMigrationApp.fixture";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";

it("retains the composed research review across restart without changing saved work", async () => {
  const f = await contextMigrationAppFixture();
  try {
    const graph = await f.graph();
    const original = await readFile(f.chapterPath);
    const input = {
      chapterId: "chapter",
      revision: mcpContextRevision({
        ...graph,
        storyMemory: graph.chapters[0].storyMemory,
      }),
      requestId: randomUUID(),
      changes: [
        {
          change: {
            changeId: "term",
            entity: "glossary",
            values: { source: "Research term", target: "Reviewed name" },
          },
          reason: "Caller reviewed this source",
          sources: [
            { title: "Reference", url: "https://example.com/reference" },
          ],
        },
      ],
    };
    const proposed = (await f.invoke(
      "carrot_preview_context_research",
      input,
    )) as { proposalId: string };
    const args = { proposalId: proposed.proposalId };
    const reviewed = await f.invoke("carrot_get_context_proposal", args);
    expect(reviewed).toMatchObject({
      proposalId: proposed.proposalId,
      retention: "seven-days",
      changes: [{ sources: input.changes[0].sources }],
    });
    await f.restart();
    expect(await f.invoke("carrot_get_context_proposal", args)).toEqual(
      reviewed,
    );
    expect(await f.invoke("carrot_preview_context_research", input)).toEqual(
      proposed,
    );
    expect((await f.storage.index()).entries).toMatchObject([
      { id: proposed.proposalId, kind: "research-proposal" },
    ]);
    expect(await readFile(f.chapterPath)).toEqual(original);
    expect((await f.graph()).styleGuide).toEqual(graph.styleGuide);
    expect(
      await readFile(await f.storage.path(proposed.proposalId), "utf8"),
    ).not.toMatch(/Reviewed name|Research term|example.com/);
  } finally {
    await f.close();
  }
});
