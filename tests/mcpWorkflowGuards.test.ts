import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { workflowFixture } from "./mcpWorkflow.fixture";

it("deduplicates identical preparation while rejecting changed targets and foreign owners", async () => {
  const f = await workflowFixture();
  try {
    const before = await readFile(f.chapterPath);
    const plan = await f.prepare([{ kind: "export-png" }]);
    const stored = (await f.storage.record(plan.id)) as {
      input: Record<string, unknown>;
    };
    expect(
      await f.invoke("carrot_prepare_workflow", stored.input),
    ).toMatchObject({ id: plan.id });
    await expect(
      f.invoke("carrot_prepare_workflow", {
        ...stored.input,
        reason: "different",
      }),
    ).rejects.toThrow("different");
    for (const name of [
      "carrot_get_workflow",
      "carrot_pause_workflow",
      "carrot_cancel_workflow",
    ])
      await expect(
        f.invoke(name, { id: plan.id }, f.auth("foreign-owner")),
      ).rejects.toThrow();
    expect(
      await f.invoke("carrot_list_workflows", {}, f.auth("foreign-owner")),
    ).toMatchObject({ total: 0 });
    await expect(
      f.invoke("carrot_run_workflow", {
        id: plan.id,
        requestId: randomUUID(),
        version: plan.version + 1,
      }),
    ).rejects.toThrow("version");
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.request).not.toHaveBeenCalled();
    expect(
      (await f.storage.index()).entries.filter(
        (entry) => entry.kind === "workflow",
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("rejects arbitrary tool names paths duplicate pages and malformed workflow controls", async () => {
  const f = await workflowFixture();
  try {
    const plan = await f.prepare([{ kind: "export-png" }]);
    const stored = (await f.storage.record(plan.id)) as {
      input: {
        chapters: { chapterId: string; pages: object[] }[];
        stages: object[];
      };
    };
    for (const fields of [
      { stages: [{ kind: "execute", command: "arbitrary" }] },
      { stages: [...stored.input.stages, ...stored.input.stages] },
      { chapters: [...stored.input.chapters, ...stored.input.chapters] },
      {
        chapters: [
          {
            chapterId: "chapter",
            pages: [
              stored.input.chapters[0].pages[0],
              stored.input.chapters[0].pages[0],
            ],
          },
        ],
      },
      { path: "C:/private.png" },
      { maxPageAttempts: 0 },
    ])
      await expect(
        f.invoke("carrot_prepare_workflow", {
          ...stored.input,
          requestId: randomUUID(),
          ...fields,
        }),
      ).rejects.toThrow();
    await expect(
      f.invoke("carrot_get_workflow", { id: plan.id, snapshot: {} }),
    ).rejects.toThrow();
    await expect(
      f.invoke("carrot_discard_workflow", { id: plan.id, confirm: false }),
    ).rejects.toThrow();
    expect(
      await f.invoke("carrot_discard_workflow", { id: plan.id, confirm: true }),
    ).toMatchObject({ pageChanges: 0 });
    await expect(f.get(plan.id)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.render).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("binds pagination to the exact owned plan versions", async () => {
  const f = await workflowFixture();
  try {
    const first = await f.prepare([{ kind: "export-png" }]);
    await f.prepare([{ kind: "await-external", purpose: "reading" }]);
    const list = (await f.invoke("carrot_list_workflows", { limit: 1 })) as {
      snapshot: string;
      total: number;
    };
    expect(list.total).toBe(2);
    await expect(
      f.invoke("carrot_list_workflows", { offset: 1 }),
    ).rejects.toThrow();
    expect(
      await f.invoke("carrot_list_workflows", {
        offset: 1,
        snapshot: list.snapshot,
      }),
    ).toMatchObject({ total: 2 });
    await f.invoke("carrot_pause_workflow", { id: first.id });
    await expect(
      f.invoke("carrot_list_workflows", { offset: 1, snapshot: list.snapshot }),
    ).rejects.toThrow("changed");
  } finally {
    await f.close();
  }
});

it("refuses unapproved PNG execution even though plan preparation does not transfer images", async () => {
  const f = await workflowFixture();
  try {
    const plan = await f.prepare([{ kind: "export-png" }]);
    const caller = f.auth();
    caller.assertJobAuthorized.mockImplementation(
      (scopes?: readonly string[]) => {
        if (scopes?.includes("carrot.images"))
          throw new Error("No image grant");
      },
    );
    await expect(
      f.invoke(
        "carrot_run_workflow",
        { id: plan.id, version: plan.version, requestId: randomUUID() },
        caller,
      ),
    ).rejects.toThrow("No image grant");
    expect((await f.get(plan.id)).status).toBe("prepared");
    expect(f.render).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("does not publish a prepared plan after authorization is revoked during encryption", async () => {
  const f = await workflowFixture();
  const encrypt = f.encryption.encrypt;
  let permitted = true;
  const caller = f.auth();
  const guard = () => {
    if (!permitted) throw new Error("revoked");
  };
  caller.assertAuthorized.mockImplementation(guard);
  caller.assertJobAuthorized.mockImplementation(guard);
  const hook = vi.spyOn(f.encryption, "encrypt").mockImplementation((text) => {
    if (JSON.parse(text).payload?.steps) permitted = false;
    return encrypt(text);
  });
  try {
    const chapter = await f.library.openChapter("chapter");
    const { createPageRevision } = await import("../src/shared/pageRevision");
    await expect(
      f.invoke(
        "carrot_prepare_workflow",
        {
          requestId: randomUUID(),
          reason: "revocation fixture",
          stages: [{ kind: "export-png" }],
          chapters: [
            {
              chapterId: "chapter",
              pages: [
                {
                  pageId: chapter.pages[0].id,
                  revision: createPageRevision(chapter.pages[0]),
                },
              ],
            },
          ],
        },
        caller,
      ),
    ).rejects.toThrow("revoked");
    expect((await f.storage.index()).entries).toEqual([]);
    expect(f.render).not.toHaveBeenCalled();
  } finally {
    hook.mockRestore();
    await f.close();
  }
});

it("rejects corrupt or missing checkpoints rather than silently reconstructing runnable work", async () => {
  const f = await workflowFixture();
  try {
    const plan = await f.prepare([{ kind: "export-png" }]);
    const path = await f.storage.path(plan.id);
    const before = await readFile(path);
    await writeFile(path, "{broken");
    await expect(f.get(plan.id)).rejects.toThrow();
    await expect(
      f.invoke("carrot_run_workflow", {
        id: plan.id,
        version: 0,
        requestId: randomUUID(),
      }),
    ).rejects.toThrow();
    await writeFile(path, before);
    expect((await f.get(plan.id)).status).toBe("prepared");
    expect(f.render).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
