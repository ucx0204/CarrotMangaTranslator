import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { imageEditingFixture, brushCommand } from "./mcpImageEditing.fixture";

it("rejects malformed, duplicate, missing, excluded and generated targets without saving or loading an engine", async () => {
  const f = await imageEditingFixture();
  try {
    const initial = await readFile(f.chapterPath);
    const base = await f.input(brushCommand());
    const block = {
      kind: "erase-blocks",
      expectedEngine: "lama-manga",
      allowAssetDownloads: true,
      protectedAreas: [],
    };
    for (const command of [
      { ...block, blockIds: [] },
      { ...block, blockIds: ["a", "a"] },
      { ...block, blockIds: ["missing"] },
      { ...brushCommand(), extra: true },
      {
        ...brushCommand(),
        strokes: [{ points: [{ x: -1, y: 2 }], radiusPx: 5 }],
      },
      {
        ...brushCommand(),
        strokes: [{ points: [{ x: 100, y: 2 }], radiusPx: 5 }],
      },
      {
        ...brushCommand(),
        strokes: [{ points: [{ x: 2, y: 2 }], radiusPx: 181 }],
      },
    ])
      await expect(
        f.invoke("carrot_preview_image_edit", { ...base, command }),
      ).rejects.toThrow();
    expect(await readFile(f.chapterPath)).toEqual(initial);
    for (const field of ["inpaintExcluded", "generatedLettering"]) {
      const stored = JSON.parse(initial.toString());
      stored.pages[0].blocks[0][field] =
        field === "inpaintExcluded"
          ? true
          : {
              version: 1,
              dataUrl: `data:image/png;base64,${f.bytes.toString("base64")}`,
              sourceText: "x",
              translatedText: "y",
            };
      await writeFile(f.chapterPath, JSON.stringify(stored));
      await expect(
        f.preview({
          ...block,
          kind: "erase-blocks",
          expectedEngine: "lama-manga",
          blockIds: ["a"],
        }),
      ).rejects.toThrow(/eligible/);
    }
    expect(f.acquireEngine).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects inconsistent orphan mask metadata rather than producing a plan that cannot be exactly recovered", async () => {
  const f = await imageEditingFixture();
  try {
    const stored = JSON.parse(await readFile(f.chapterPath, "utf8"));
    stored.pages[0].maskProvenance = "derived-diff";
    await writeFile(f.chapterPath, JSON.stringify(stored));
    const before = await readFile(f.chapterPath);
    await expect(f.preview(brushCommand())).rejects.toThrow(/mask metadata/);
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});

it("excludes a fully protected mask and never substitutes a larger erasure area", async () => {
  const f = await imageEditingFixture();
  try {
    const before = await readFile(f.chapterPath);
    const plan = await f.preview({
      ...brushCommand(),
      protectedAreas: [
        { kind: "rectangle", start: { x: 0, y: 0 }, end: { x: 99, y: 99 } },
      ],
    });
    expect(plan.canApply).toBe(false);
    expect((await f.inspect(plan.batchId)).changes[0]).toMatchObject({
      changed: false,
      excludedReason: "empty_effective_mask",
    });
    await expect(f.action(plan.batchId, "apply")).rejects.toThrow(/eligible/);
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.acquireEngine).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(["consent", "engine"] as const)(
  "refuses absent %s before acquiring a model",
  async (kind) => {
    const f = await imageEditingFixture();
    try {
      const command = brushCommand();
      if (!("expectedEngine" in command)) throw new Error("Expected erasure");
      if (kind === "consent") command.allowAssetDownloads = false;
      else command.expectedEngine = "flux-klein";
      const before = await readFile(f.chapterPath),
        plan = await f.preview(command);
      expect((await f.action(plan.batchId, "apply")).result.status).toBe(
        "failed",
      );
      expect(await readFile(f.chapterPath)).toEqual(before);
      expect(f.acquireEngine).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it.each(["page", "image", "context"] as const)(
  "rejects stale %s state before inference",
  async (kind) => {
    const f = await imageEditingFixture();
    try {
      const plan = await f.preview(brushCommand());
      if (kind === "page") {
        const stored = JSON.parse(await readFile(f.chapterPath, "utf8"));
        stored.pages[0].blocks[0].sourceText = "later user edit";
        await writeFile(f.chapterPath, JSON.stringify(stored));
      } else if (kind === "image") {
        const page = (await f.snapshot()).pages[0];
        await writeFile(
          page.imagePath,
          Buffer.concat([f.bytes, Buffer.from("changed")]),
        );
      } else {
        const context = await f.library.readWorkContextForEdit("chapter");
        await f.library.saveWorkStyleGuide({
          ...context.styleGuide,
          rules: { ...context.styleGuide.rules, defaultTone: "literal" },
        });
      }
      const before = await readFile(f.chapterPath);
      expect((await f.action(plan.batchId, "apply")).result.status).toBe(
        "failed",
      );
      expect(await readFile(f.chapterPath)).toEqual(before);
      expect(f.acquireEngine).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it("conceals another owner's plan and refuses stale undo after a user changes text", async () => {
  const f = await imageEditingFixture();
  try {
    const plan = await f.preview(brushCommand());
    await expect(
      f.invoke(
        "carrot_get_image_edit",
        { batchId: plan.batchId },
        f.auth("other"),
      ),
    ).rejects.toThrow(/another connection/);
    await f.action(plan.batchId, "apply");
    const stored = JSON.parse(await readFile(f.chapterPath, "utf8"));
    stored.pages[0].blocks[0].translatedText = "keep me";
    await writeFile(f.chapterPath, JSON.stringify(stored));
    const before = await readFile(f.chapterPath);
    expect((await f.action(plan.batchId, "undo")).result.status).toBe("failed");
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});
