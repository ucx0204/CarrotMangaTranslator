import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { typographyBatchAppFixture } from "./mcpTypographyBatchApp.fixture";

async function changedOriginal(path: string) {
  const image = PNG.sync.read(await readFile(path));
  image.data[0] = image.data[0] === 255 ? 254 : 255;
  await writeFile(path, PNG.sync.write(image));
}

it("uses owned observations, native handoffs and real storage for apply/undo/redo", async () => {
  const f = await typographyBatchAppFixture();
  try {
    const request = await f.analyze();
    const original = await f.library.openChapter("chapter");
    const plan = await f.invoke("carrot_preview_typography_batch", request);
    expect(plan.canApply).toBe(true);
    expect(f.editing.notifySaved).not.toHaveBeenCalled();
    const inspected = await f.inspect(plan.batchId);
    expect(inspected.changes[0].after).toMatchObject({
      fontFamily: "jua",
      fontSizeIntent: "source-match",
    });
    expect(JSON.stringify(inspected)).not.toMatch(
      /imagePath|sourceImageSha256|beforeBlock|afterBlock/,
    );
    const action = randomUUID();
    await f.action(plan.batchId, "apply", action);
    const applied = await f.done(plan.batchId);
    expect(applied.status).toBe("completed");
    expect(f.editing.notifySaved).toHaveBeenCalledTimes(2);
    expect((await f.action(plan.batchId, "apply", action)).historical).toBe(
      true,
    );
    const after = await f.library.openChapter("chapter");
    expect(after.pages[0].blocks[0].fontSizePx).toBe(
      original.pages[0].blocks[0].fontSizePx,
    );
    expect(after.pages[0].blocks[0].sourceFontFacePx).toBeGreaterThan(0);
    expect(after.pages[0].blocks[1]).toEqual(original.pages[0].blocks[1]);
    await f.action(plan.batchId, "undo");
    expect((await f.done(plan.batchId)).status).toBe("completed");
    expect(
      (await f.library.openChapter("chapter")).pages.map((page) => page.blocks),
    ).toEqual(original.pages.map((page) => page.blocks));
    await f.action(plan.batchId, "redo");
    expect((await f.done(plan.batchId)).status).toBe("completed");
    expect(
      (await f.library.openChapter("chapter")).pages.map((page) => page.blocks),
    ).toEqual(after.pages.map((page) => page.blocks));
    for (const page of original.pages)
      expect(await readFile(page.imagePath)).toEqual(f.bytes);
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.app.jobs.all).toEqual([]);
    expect(f.app.jobs.pageHandoffs.activities).toEqual([]);
  } finally {
    await f.close();
  }
});

it.each(["preview", "apply", "redo"])(
  "rejects modified original bytes at %s without an additional save",
  async (stage) => {
    const f = await typographyBatchAppFixture("size");
    try {
      const request = await f.analyze();
      if (stage === "preview") {
        await changedOriginal(f.chapter.pages[0].imagePath);
        await expect(
          f.invoke("carrot_preview_typography_batch", request),
        ).rejects.toMatchObject({ code: "revision_conflict" });
      } else {
        const plan = await f.invoke("carrot_preview_typography_batch", request);
        if (stage === "redo") {
          await f.action(plan.batchId, "apply");
          await f.done(plan.batchId);
          await f.action(plan.batchId, "undo");
          await f.done(plan.batchId);
        }
        const before = await readFile(f.chapterPath);
        const savedCount = f.editing.notifySaved.mock.calls.length;
        await changedOriginal(f.chapter.pages[1].imagePath);
        await f.action(plan.batchId, stage);
        const result = await f.done(plan.batchId);
        expect(result.status).toBe("failed");
        expect(result.pages[0].errorCode).toBe("revision_conflict");
        expect(await readFile(f.chapterPath)).toEqual(before);
        expect(f.editing.notifySaved).toHaveBeenCalledTimes(savedCount);
      }
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.app.jobs.all).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it("can undo without source files, but refuses a forward edit until evidence is available", async () => {
  const f = await typographyBatchAppFixture("size");
  const path = f.chapter.pages[0].imagePath;
  try {
    const request = await f.analyze();
    const original = await f.library.openChapter("chapter");
    const plan = await f.invoke("carrot_preview_typography_batch", request);
    await f.action(plan.batchId, "apply");
    await f.done(plan.batchId);
    await rename(path, `${path}.retained-test`);
    await f.action(plan.batchId, "undo");
    expect((await f.done(plan.batchId)).status).toBe("completed");
    expect(
      (await f.library.openChapter("chapter")).pages.map((page) => page.blocks),
    ).toEqual(original.pages.map((page) => page.blocks));
    await f.action(plan.batchId, "redo");
    expect((await f.done(plan.batchId)).status).toBe("failed");
    expect(f.app.jobs.all).toEqual([]);
  } finally {
    await f.close();
  }
});

it("rejects another owner's observation and refuses raw block/evidence payloads", async () => {
  const f = await typographyBatchAppFixture();
  try {
    const request = await f.analyze();
    const before = await readFile(f.chapterPath);
    await expect(
      f.invoke("carrot_preview_typography_batch", request, {
        ...f.auth,
        principalId: "different-owner",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      f.invoke("carrot_preview_typography_batch", {
        ...request,
        observation: {},
      }),
    ).rejects.toThrow();
    await expect(
      f.invoke("carrot_preview_typography_batch", { ...request, blocks: [] }),
    ).rejects.toThrow();
    await expect(
      f.invoke("carrot_preview_typography_batch", {
        ...request,
        analysisJobId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});

it("detects changed work-font profiles after preview while allowing exact undo", async () => {
  const f = await typographyBatchAppFixture("font");
  const { makeProfile } =
    await import("./helpers/automaticFontMatchingV2Fixtures");
  try {
    const request = await f.analyze();
    const before = await readFile(f.chapterPath);
    const plan = await f.invoke("carrot_preview_typography_batch", request);
    await f.library.writeWorkTypographyProfile(makeProfile({ workId: "work" }));
    await f.action(plan.batchId, "apply");
    const result = await f.done(plan.batchId);
    expect(result.status).toBe("failed");
    expect(result.pages[0].errorCode).toBe("revision_conflict");
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.editing.notifySaved).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("retains all analyzed dependency leases through the actual save notification", async () => {
  const f = await typographyBatchAppFixture("size");
  const { assertLibraryActivityAccess, withLibraryActivityOwner } =
    await import("../src/main/library/lock");
  try {
    const request = await f.analyze();
    request.pages = [request.pages[0]];
    const plan = await f.invoke("carrot_preview_typography_batch", request);
    f.editing.notifySaved.mockImplementation(() => {
      expect(() =>
        withLibraryActivityOwner("unrelated-editor", () =>
          assertLibraryActivityAccess([
            { kind: "page-content", scope: "chapter/second", access: "write" },
          ]),
        ),
      ).toThrow();
    });
    await f.action(plan.batchId, "apply");
    expect((await f.done(plan.batchId)).status).toBe("completed");
    expect(f.editing.notifySaved).toHaveBeenCalledOnce();
    expect(() =>
      withLibraryActivityOwner("unrelated-editor", () =>
        assertLibraryActivityAccess([
          { kind: "page-content", scope: "chapter/second", access: "write" },
        ]),
      ),
    ).not.toThrow();
  } finally {
    await f.close();
  }
});
