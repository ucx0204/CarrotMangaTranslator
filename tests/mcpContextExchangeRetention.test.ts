import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { contextMigrationAppFixture } from "./mcpContextMigrationApp.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import { MCP_UPLOAD_CHUNK_BYTES } from "../src/shared/mcpImageUploads";
import {
  McpContextImportApplySchema,
  McpContextImportPreviewSchema,
  type McpContextImportSelection,
} from "../src/shared/mcpContextExchange";
import { encodeMcpContextExchangePayload } from "../src/shared/mcpContextExchangePayload";
import { RetainedContextMigrationSchema } from "../src/shared/mcpContextMigrationState";

const owner = "context-exchange-owner";
const guard = () => {};
async function fixture() {
  const f = await contextMigrationAppFixture();
  const { McpFileUploadStore } =
    await import("../src/main/mcp/mcpFileUploadStore");
  const { McpContextMigrationRepository } =
    await import("../src/main/mcp/mcpContextMigrationRepository");
  const { McpContextMigrationApplication } =
    await import("../src/main/mcp/mcpContextMigrationApplication");
  const { McpContextExchangeApplication } =
    await import("../src/main/mcp/mcpContextExchangeApplication");
  const source = await import("../src/main/mcp/mcpContextExchangeSource");
  const open = () => {
    const lifetime = new AbortController();
    const uploads = new McpFileUploadStore();
    const migration = new McpContextMigrationApplication(
      new McpContextMigrationRepository(f.storage),
      f.app,
      f.editing,
      lifetime.signal,
    );
    return {
      lifetime,
      uploads,
      migration,
      service: new McpContextExchangeApplication(
        uploads,
        migration,
        lifetime.signal,
      ),
    };
  };
  let current = open();
  const prepare = async (includeMemory = true, changeRules = false) => {
    const state = await source.readMcpContextExchangeState(
      {
        workId: "work",
        chapterId: "chapter",
        scope: "guide-and-memory",
      },
      guard,
    );
    if (!state.payload.guide) throw new Error("Expected native guide");
    const entry = state.payload.guide.characters[0];
    entry.targetName = "Reviewed offline name";
    entry.origin = "manual";
    if (changeRules) state.payload.guide.rules.honorifics = "drop";
    const selections: McpContextImportSelection[] = [
      {
        changeId: "character",
        entity: "character",
        entryId: entry.id,
        fields: ["targetName"],
      },
    ];
    if (includeMemory) {
      const chapter = (await f.graph()).chapters[0].chapter;
      const page = chapter.pages[0];
      const memory = await f.library.getChapterStoryMemory("chapter");
      memory.pages = [
        {
          pageId: page.id,
          pageName: "uploaded stale name",
          pageIndex: 0,
          summary: "Reviewed saved-page summary",
          sourceDigest: "untrusted imported evidence",
          translatedDigest: "untrusted imported translation",
          updatedAt: "untrusted timestamp",
        },
      ];
      state.payload.memory = memory;
      selections.push({
        changeId: "memory",
        entity: "memory",
        pageId: page.id,
        pageRevision: createPageRevision(page),
        fields: ["summary"],
      });
    }
    const bytes = Buffer.from(encodeMcpContextExchangePayload(state.payload));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const uploaded = await current.uploads.begin(
      owner,
      {
        requestId: randomUUID(),
        filename: "edited-context.JSON",
        bytes: bytes.length,
        sha256,
      },
      null,
      guard,
    );
    for (
      let offset = 0;
      offset < bytes.length;
      offset += MCP_UPLOAD_CHUNK_BYTES
    )
      await current.uploads.chunk(
        owner,
        {
          uploadId: uploaded.uploadId,
          offset,
          data: bytes
            .subarray(offset, offset + MCP_UPLOAD_CHUNK_BYTES)
            .toString("base64"),
        },
        guard,
      );
    await current.uploads.finish(owner, uploaded.uploadId, guard);
    const input = McpContextImportPreviewSchema.parse({
      chapterId: "chapter",
      uploadId: uploaded.uploadId,
      requestId: randomUUID(),
      selections,
    });
    const review = await current.service.preview(owner, input, guard);
    const apply = McpContextImportApplySchema.parse({
      chapterId: input.chapterId,
      uploadId: input.uploadId,
      requestId: input.requestId,
      selections,
      sourceSha256: review.sourceSha256,
      referenceSnapshot: review.referenceSnapshot,
      planFingerprint: review.planFingerprint,
      selectedChangeIds: selections.map((item) => item.changeId),
    });
    return { input, apply, review, bytes };
  };
  return {
    ...f,
    prepare,
    currentContext: () => current,
    restartContext: async () => {
      current.lifetime.abort();
      await current.uploads.close();
      await f.restart();
      current = open();
    },
    close: async () => {
      current.lifetime.abort();
      await current.uploads.close();
      await f.close();
    },
  };
}

it("publishes native guide/memory and encrypted recovery together, then replays without a live upload", async () => {
  const f = await fixture();
  try {
    const before = await f.graph();
    const chapterBytes = await readFile(f.chapterPath);
    const images = await Promise.all(
      before.chapters.flatMap(({ chapter }) =>
        chapter.pages.map(async (page) => ({
          path: page.imagePath,
          bytes: await readFile(page.imagePath),
        })),
      ),
    );
    const { apply } = await f.prepare();
    const result = await f.currentContext().service.apply(owner, apply, guard);
    expect(result).toMatchObject({
      status: "saved",
      historical: false,
      changes: { guideChanged: true, pages: 0, blocks: 0, memories: 1 },
    });
    const saved = await f.graph();
    expect(saved.styleGuide.characters[0]).toMatchObject({
      targetName: "Reviewed offline name",
      origin: before.styleGuide.characters[0].origin,
    });
    expect(saved.chapters[0].storyMemory.pages[0]).toMatchObject({
      summary: "Reviewed saved-page summary",
      sourceDigest: "",
      translatedDigest: "",
    });
    expect(await readFile(f.chapterPath)).toEqual(chapterBytes);
    for (const image of images)
      expect(await readFile(image.path)).toEqual(image.bytes);
    const record = RetainedContextMigrationSchema.parse(
      await f.storage.record(result.id),
    );
    expect(record.operation).toBe("carrot_apply_context_import");
    expect(record.delta.memories[0].beforePresent).toBe(false);
    const encrypted = JSON.parse(
      await readFile(await f.storage.path(result.id), "utf8"),
    );
    expect(Object.keys(encrypted)).toEqual(["encrypted"]);
    expect(await f.codec.open(encrypted)).toEqual(record);
    await f.restartContext();
    const reopened = vi.spyOn(f.currentContext().uploads, "withFile");
    const replay = await f.currentContext().service.apply(owner, apply, guard);
    expect(replay).toMatchObject({
      id: result.id,
      historical: true,
      status: "already_applied",
    });
    expect(reopened).not.toHaveBeenCalled();
    await expect(
      f
        .currentContext()
        .service.apply(
          owner,
          { ...apply, selectedChangeIds: ["character"] },
          guard,
        ),
    ).rejects.toThrow(/requestId/);
    const migration = f.currentContext().migration;
    const inspect = await migration.inspect(owner, result.id, guard);
    await migration.recover(
      owner,
      {
        id: result.id,
        requestId: randomUUID(),
        referenceSnapshot: inspect.referenceSnapshot,
      },
      "undo",
      guard,
    );
    expect((await f.graph()).styleGuide).toEqual(before.styleGuide);
    const memoryPath = join(
      f.env.libraryDir,
      "works",
      "work",
      "chapters",
      "chapter",
      "story-memory.json",
    );
    await expect(readFile(memoryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const undone = await migration.inspect(owner, result.id, guard);
    await migration.recover(
      owner,
      {
        id: result.id,
        requestId: randomUUID(),
        referenceSnapshot: undone.referenceSnapshot,
      },
      "redo",
      guard,
    );
    expect((await f.graph()).styleGuide).toEqual(saved.styleGuide);
    expect((await f.graph()).chapters[0].storyMemory).toEqual(
      saved.chapters[0].storyMemory,
    );
  } finally {
    await f.close();
  }
});

it("keeps authorization and the owned upload lease live through encrypted native staging", async () => {
  const f = await fixture();
  const seal = f.codec.seal;
  let restore = () => {};
  try {
    const { apply } = await f.prepare();
    const before = (await f.graph()).styleGuide;
    const operation = new AbortController();
    const cancelled = new Error(
      "context import cancelled during encrypted staging",
    );
    let entered = false;
    const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const sealed = await seal(value);
      if (
        !entered &&
        typeof value === "object" &&
        value !== null &&
        "delta" in value
      ) {
        entered = true;
        expect(() =>
          f.currentContext().uploads.discard(owner, apply.uploadId, guard),
        ).toThrow(/in use/);
        operation.abort(cancelled);
      }
      return sealed;
    });
    restore = () => hook.mockRestore();
    await expect(
      f.currentContext().service.apply(owner, apply, guard, operation.signal),
    ).rejects.toBe(cancelled);
    expect(entered).toBe(true);
    expect((await f.graph()).styleGuide).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    await expect(
      f.currentContext().uploads.discard(owner, apply.uploadId, guard),
    ).resolves.toMatchObject({ discarded: true });
  } finally {
    restore();
    await f.close();
  }
});

it("rejects stale native review and an unowned upload without writing any context", async () => {
  const f = await fixture();
  try {
    const { input, apply } = await f.prepare(false);
    expect(() =>
      f.currentContext().service.preview("another-owner", input, guard),
    ).toThrow(/unavailable/);
    const current = await f.library.getWorkStyleGuide("work");
    current.rules.sfxMode = "preserve";
    await f.library.saveWorkStyleGuide(current);
    const before = await f.library.getWorkStyleGuide("work");
    await expect(
      f.currentContext().service.apply(owner, apply, guard),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(await f.library.getWorkStyleGuide("work")).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    await f.close();
  }
});

it("restores an originally absent guide after a rules-only native import", async () => {
  const f = await fixture();
  try {
    const { apply } = await f.prepare(false, true);
    const path = join(f.env.libraryDir, "works", "work", "style-guide.json");
    await rm(path);
    // The input's full native guide can supply selected rules without creating entries.
    const input = McpContextImportPreviewSchema.parse({
      chapterId: "chapter",
      uploadId: apply.uploadId,
      requestId: randomUUID(),
      selections: [
        { changeId: "rules", entity: "rules", fields: ["honorifics"] },
      ],
    });
    const review = await f
      .currentContext()
      .service.preview(owner, input, guard);
    const request = McpContextImportApplySchema.parse({
      chapterId: input.chapterId,
      uploadId: input.uploadId,
      requestId: input.requestId,
      selections: input.selections,
      sourceSha256: review.sourceSha256,
      referenceSnapshot: review.referenceSnapshot,
      planFingerprint: review.planFingerprint,
      selectedChangeIds: ["rules"],
    });
    const result = await f
      .currentContext()
      .service.apply(owner, request, guard);
    expect(result.status).toBe("saved");
    expect((await f.library.getWorkStyleGuide("work")).characters).toEqual([]);
    const record = RetainedContextMigrationSchema.parse(
      await f.storage.record(result.id),
    );
    expect(record.guideBeforePresent).toBe(false);
    const migration = f.currentContext().migration;
    const inspected = await migration.inspect(owner, result.id, guard);
    await migration.recover(
      owner,
      {
        id: result.id,
        requestId: randomUUID(),
        referenceSnapshot: inspected.referenceSnapshot,
      },
      "undo",
      guard,
    );
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.close();
  }
});
