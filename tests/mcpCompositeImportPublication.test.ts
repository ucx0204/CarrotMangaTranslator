import { expect, it } from "vitest";
import { compositeImportPublicationFixture } from "./mcpCompositeImportPublication.fixture";
import { mutation } from "./mcpCompositeWorkflow.fixture";

it("advances an unchanged native import only from the exact retained publication metadata", async () => {
  const f = await compositeImportPublicationFixture();
  try {
    const publication = f.receipt.pageMapping?.publication;
    expect(publication?.workId).toBe(f.receipt.workId);
    expect(publication?.workSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(publication?.chapters.map((chapter) => chapter.chapterId)).toEqual(
      f.receipt.chapterIds,
    );
    expect(publication?.guideSha256).toBeNull();
    expect(publication?.chapters[0].memorySha256).toBeNull();
    const waiting = f.service.waitForCompletion(
      f.owner,
      f.prepared.id,
      f.guard,
    );
    f.release.resolve();
    const completed = await waiting;
    expect(completed.status).toBe("completed");
    expect(completed.targets.map((page) => page.pageId)).toEqual(
      f.receipt.pageMapping?.items.map((item) => item.page.pageId),
    );
    expect(completed.used.admissions).toBe(1);
    expect(JSON.stringify(publication)).not.toContain(f.env.root);
  } finally {
    await f.close();
  }
});

it.each([
  "membership",
  "page-name",
  "chapter-title",
  "work-title",
  "sfx-review",
  "guide",
  "memory",
] as const)(
  "holds after a post-publication %s change and cannot adopt it during exact reconciliation",
  async (kind) => {
    const f = await compositeImportPublicationFixture();
    try {
      await f.mutate(kind);
      const waiting = f.service.waitForCompletion(
        f.owner,
        f.prepared.id,
        f.guard,
      );
      const rejected = expect(waiting).rejects.toThrow("metadata changed");
      f.release.resolve();
      await rejected;
      const held = await f.service.get(f.owner, f.prepared.id, f.guard);
      expect(held.status).toBe("held");
      expect(held.phases[0].outcome?.status).toBe("completed");
      expect(held.targets).toEqual([]);
      expect(held.snapshot).toEqual(f.prepared.snapshot);
      expect(held.used.admissions).toBe(1);
      await expect(
        f.service.reconcile(f.owner, mutation(held), f.guard),
      ).rejects.toThrow("metadata changed");
      expect(
        (await f.service.get(f.owner, f.prepared.id, f.guard)).snapshot,
      ).toEqual(f.prepared.snapshot);
      expect(f.validate).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
  },
);

it("retains the font environment from the initial zero-page prepare through import refresh", async () => {
  const f = await compositeImportPublicationFixture();
  try {
    f.changeFonts();
    const waiting = f.service.waitForCompletion(
      f.owner,
      f.prepared.id,
      f.guard,
    );
    const rejected = expect(waiting).rejects.toThrow("fixed composite");
    f.release.resolve();
    await rejected;
    const held = await f.service.get(f.owner, f.prepared.id, f.guard);
    expect(held.status).toBe("held");
    expect(held.phases[0].outcome?.status).toBe("completed");
    expect(held.targets).toEqual([]);
    expect(held.snapshot).toEqual(f.prepared.snapshot);
    await expect(
      f.service.reconcile(f.owner, mutation(held), f.guard),
    ).rejects.toThrow("fixed composite");
    expect(
      (await f.service.get(f.owner, f.prepared.id, f.guard)).targets,
    ).toEqual([]);
    expect(
      (await f.service.get(f.owner, f.prepared.id, f.guard)).snapshot,
    ).toEqual(f.prepared.snapshot);
    expect(f.validate).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});
