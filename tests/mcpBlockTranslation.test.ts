import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { McpBlockTranslationService } from "../src/main/application/mcpBlockTranslationService";
import { createPageRevision } from "../src/shared/pageRevision";
import { editingFixture } from "./mcpEditing.fixture";

function fixture() {
  const f = editingFixture();
  const controller = new AbortController();
  const evidence = {
    translatedText: "새 번역 🥕\n둘째 줄",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    model: "fixture-model",
    engine: "gemma",
    execution: "local" as const,
    contextRevision: "a".repeat(16),
    contextPruned: false,
  };
  const translate = vi.fn<
    ConstructorParameters<typeof McpBlockTranslationService>[0]["translate"]
  >(async () => structuredClone(evidence));
  const observer = new McpBlockTranslationService({
    openChapter: f.openChapter,
    translate,
  });
  const context = {
    id: randomUUID(),
    signal: controller.signal,
    assertAuthorized: vi.fn(() => controller.signal.throwIfAborted()),
    progress: vi.fn(),
  };
  const target = {
    chapterId: "chapter",
    pageId: "page",
    blockId: "a",
    revision: createPageRevision(f.chapter.pages[0]),
    requestId: randomUUID(),
    contextMode: "saved" as const,
  };
  return { ...f, controller, evidence, translate, observer, context, target };
}

describe("single saved-block translation proposals", () => {
  it("passes only selected source text, saves nothing and applies through the existing editor", async () => {
    const f = fixture();
    const before = structuredClone(f.chapter);
    const result = await f.observer.run(f.target, f.context);
    expect(result).toMatchObject({
      status: "proposed",
      pagesChanged: 0,
      performed: ["block-translation"],
      blockTranslation: {
        sourceText: "source",
        previousTranslatedText: "original-a",
        translatedText: f.evidence.translatedText,
        requestCount: 1,
        differs: true,
        warnings: [
          "review_before_apply",
          "generated_lettering_retained",
          "saved_context_may_have_changed",
        ],
      },
    });
    expect(f.translate).toHaveBeenCalledWith(
      {
        chapterId: "chapter",
        workId: "work",
        pageId: "page",
        pageIndex: 0,
        previousPageIds: [],
        blockId: "a",
        sourceText: "source",
        textRole: "sound",
        contextMode: "saved",
      },
      f.context,
    );
    expect(f.chapter).toEqual(before);
    expect(f.savePageBlocks).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE|\/private\/|resource_link|imagePath/,
    );
    const proposal = requireProposal(result);
    if (!proposal) throw new Error("Expected proposal");
    const applied = await f.service.update({
      ...f.request,
      revision: result.revision,
      edits: [{ blockId: "a", translatedText: proposal.translatedText }],
    });
    expect(f.chapter.pages[0].blocks).toEqual([
      { ...before.pages[0].blocks[0], translatedText: proposal.translatedText },
      before.pages[0].blocks[1],
    ]);
    await f.service.update({
      ...f.request,
      revision: applied.revision,
      edits: [
        { blockId: "a", translatedText: proposal.previousTranslatedText },
      ],
    });
    expect(f.chapter).toEqual(before);
  });

  it.each(["", "  \n\t"])(
    "does not call a model for empty saved source %j",
    async (sourceText) => {
      const f = fixture();
      f.chapter.pages[0].blocks[0].sourceText = sourceText;
      f.target.revision = createPageRevision(f.chapter.pages[0]);
      expect(await f.observer.run(f.target, f.context)).toMatchObject({
        status: "no_source",
        noSourceText: true,
        pagesChanged: 0,
        performed: [],
      });
      expect(f.translate).not.toHaveBeenCalled();
      expect(f.savePageBlocks).not.toHaveBeenCalled();
    },
  );

  it("rejects stale, missing, duplicate and oversized saved targets before inference", async () => {
    const f = fixture();
    await expect(
      f.observer.run(
        { ...f.target, revision: "page-v1:0000000000000000" },
        f.context,
      ),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(
      f.observer.run({ ...f.target, blockId: "missing" }, f.context),
    ).rejects.toMatchObject({ code: "not_found" });
    f.chapter.pages[0].blocks[1].id = "a";
    f.target.revision = createPageRevision(f.chapter.pages[0]);
    await expect(f.observer.run(f.target, f.context)).rejects.toMatchObject({
      code: "invalid_edit",
    });
    f.chapter.pages[0].blocks[1].id = "b";
    f.chapter.pages[0].blocks[0].sourceText = "x".repeat(20_001);
    f.target.revision = createPageRevision(f.chapter.pages[0]);
    await expect(f.observer.run(f.target, f.context)).rejects.toMatchObject({
      code: "invalid_edit",
    });
    f.chapter.id = "other";
    await expect(f.observer.run(f.target, f.context)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(f.translate).not.toHaveBeenCalled();
  });

  it.each(["", " ", "x".repeat(8193)])(
    "rejects unusable proposal %# without saving",
    async (translatedText) => {
      const f = fixture();
      f.translate.mockResolvedValueOnce({ ...f.evidence, translatedText });
      await expect(f.observer.run(f.target, f.context)).rejects.toMatchObject({
        code: "invalid_edit",
      });
      expect(f.savePageBlocks).not.toHaveBeenCalled();
    },
  );

  it("flags identical source, unchanged translation and pruned context for review", async () => {
    const f = fixture();
    f.evidence.translatedText = "source";
    f.evidence.contextPruned = true;
    const result = await f.observer.run(f.target, f.context);
    expect(requireProposal(result).warnings).toContain("same_as_source");
    expect(requireProposal(result).warnings).toContain("context_budget_pruned");
    f.evidence.translatedText = "original-a";
    expect(
      requireProposal(await f.observer.run(f.target, f.context)).differs,
    ).toBe(false);
  });

  it("discards text on page mutation, chapter move, cancellation or revocation", async () => {
    for (const change of ["page", "work", "cancel", "revoke"]) {
      const f = fixture();
      f.translate.mockImplementationOnce(async () => {
        if (change === "page")
          f.chapter.pages[0].blocks[1].translatedText = "user edit";
        if (change === "work") f.chapter.workId = "other";
        if (change === "cancel") f.controller.abort();
        if (change === "revoke")
          f.context.assertAuthorized.mockImplementation(() => {
            throw new Error("revoked");
          });
        return f.evidence;
      });
      await expect(f.observer.run(f.target, f.context)).rejects.toThrow();
      expect(f.savePageBlocks).not.toHaveBeenCalled();
    }
  });

  it("rejects applying an old proposal after manual page editing", async () => {
    const f = fixture();
    const result = await f.observer.run(f.target, f.context);
    f.chapter.pages[0].blocks[1].translatedText = "manual";
    await expect(
      f.service.update({ ...f.request, revision: result.revision }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(f.savePageBlocks).not.toHaveBeenCalled();
  });
});

function requireProposal(
  result: Awaited<ReturnType<McpBlockTranslationService["run"]>>,
) {
  if (result.status !== "proposed") throw new Error("Expected proposal");
  return result.blockTranslation;
}
