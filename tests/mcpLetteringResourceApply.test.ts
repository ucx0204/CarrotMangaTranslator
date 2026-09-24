import { readFile, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { letteringResourcesFixture } from "./mcpLetteringResources.fixture";
import {
  createCurvePreset,
  createPerspectivePreset,
} from "../src/shared/blockTransformPresets";
import { resolveBlockStylePresetPatch } from "../src/shared/blockStylePresets";

function batchId(
  result: Awaited<
    ReturnType<Awaited<ReturnType<typeof letteringResourcesFixture>>["prepare"]>
  >,
) {
  expect(result.job.status).toBe("completed");
  if (!result.batchId) throw new Error(JSON.stringify(result.job));
  return result.batchId;
}

it("applies only selected saved preset groups through native rules and exact undo/redo", async () => {
  const f = await letteringResourcesFixture();
  const before = await f.library.openChapter("chapter");
  try {
    const preset = f.preset(
      "fixture-preset",
      "Color effect and size",
      ["color", "effect", "size"],
      {
        textColor: "#124578",
        fontSizePx: 40,
        textGlow: { enabled: true, color: "#aabbcc", blurPx: 8, opacity: 0.5 },
      },
    );
    await f.setPresets([preset]);
    const ref = await f.reference("preset", preset.id);
    const id = batchId(await f.prepare({ ...ref, groupIds: ["effect"] }));
    expect((await f.action(id, "apply")).status).toBe("completed");
    const after = await f.library.openChapter("chapter");
    expect(after.pages[0].blocks[0]).toMatchObject(
      resolveBlockStylePresetPatch({ ...preset, groupIds: ["effect"] }),
    );
    expect(after.pages[0].blocks[0].textColor).toBe(
      before.pages[0].blocks[0].textColor,
    );
    expect(after.pages[0].blocks[0].fontSizePx).toBe(
      before.pages[0].blocks[0].fontSizePx,
    );
    expect(after.pages[0].blocks[1]).toEqual(before.pages[0].blocks[1]);
    expect((await f.action(id, "undo")).status).toBe("completed");
    expect(
      (await f.library.openChapter("chapter")).pages.map((page) => page.blocks),
    ).toEqual(before.pages.map((page) => page.blocks));
    expect((await f.action(id, "redo")).status).toBe("completed");
    expect(
      (await f.library.openChapter("chapter")).pages.map((page) => page.blocks),
    ).toEqual(after.pages.map((page) => page.blocks));
    expect(f.runtime.create).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("preserves manual source size while applying the other groups in a stored style", async () => {
  const f = await letteringResourcesFixture();
  try {
    const stored = JSON.parse(await readFile(f.chapterPath, "utf8"));
    stored.pages[0].blocks[0].fontSizeIntent = "manual";
    await writeFile(f.chapterPath, JSON.stringify(stored));
    const before = await f.library.openChapter("chapter");
    const preset = f.preset(
      "manual-protection",
      "Protected size",
      ["size", "color"],
      { fontSizePx: 40, textColor: "#123456" },
    );
    await f.setPresets([preset]);
    const id = batchId(await f.prepare(await f.reference("preset", preset.id)));
    expect((await f.action(id, "apply")).status).toBe("completed");
    const after = await f.library.openChapter("chapter");
    expect(after.pages[0].blocks[0].fontSizePx).toBe(
      before.pages[0].blocks[0].fontSizePx,
    );
    expect(after.pages[0].blocks[0].fontSizeIntent).toBe("manual");
    expect(after.pages[0].blocks[0].textColor).toBe("#123456");
    expect(after.pages[1].blocks[0].fontSizePx).toBe(40);
  } finally {
    await f.close();
  }
});

it("uses block-library transforms without inserting its text, rectangles or extra blocks", async () => {
  const f = await letteringResourcesFixture();
  const before = await f.library.openChapter("chapter");
  try {
    const saved = await f.addBlockStyle({
      curveLayout: createCurvePreset("archUp"),
      perspectiveTransform: createPerspectivePreset("topNarrow"),
      rotationDeg: 7,
    });
    const bytes = await readFile(f.blocks.filePath);
    const id = batchId(
      await f.prepare({
        ...(await f.reference("block-style", saved.id)),
        groupIds: ["transform"],
      }),
    );
    expect((await f.action(id, "apply")).status).toBe("completed");
    const after = await f.library.openChapter("chapter");
    expect(after.pages[0].blocks[0].curveLayout).toEqual(
      saved.block.curveLayout,
    );
    expect(after.pages[0].blocks[0].perspectiveTransform).toEqual(
      saved.block.perspectiveTransform,
    );
    expect(after.pages[0].blocks[0].bbox).toEqual(
      before.pages[0].blocks[0].bbox,
    );
    expect(after.pages[0].blocks[0].sourceText).toBe(
      before.pages[0].blocks[0].sourceText,
    );
    expect(after.pages[0].blocks[0].translatedText).toBe(
      before.pages[0].blocks[0].translatedText,
    );
    expect(after.pages.map((page) => page.blocks.length)).toEqual(
      before.pages.map((page) => page.blocks.length),
    );
    expect(await readFile(f.blocks.filePath)).toEqual(bytes);
    expect((await f.action(id, "undo")).status).toBe("completed");
    expect(
      (await f.library.openChapter("chapter")).pages.map((page) => page.blocks),
    ).toEqual(before.pages.map((page) => page.blocks));
  } finally {
    await f.close();
  }
});

it("binds every enabled saved sequence rule in order and treats order changes as conflicts", async () => {
  const f = await letteringResourcesFixture();
  try {
    const save = async (name: string, color: string) => {
      const result = await f.rules.save({
        scheme: {
          name,
          description: "",
          match: { mode: "allBlocks", conditions: [], groups: [] },
          actions: [
            {
              id: "color",
              type: "setFields",
              enabled: true,
              changes: [{ field: "textColor", operation: "set", value: color }],
            },
          ],
        },
      });
      const rule = result.schemes.find((entry) => entry.name === name);
      if (!rule) throw new Error("Missing rule");
      return rule;
    };
    const first = await save("Sequence first", "#123456"),
      second = await save("Sequence second", "#abcdef");
    const sequence = {
      id: "ordered",
      name: "Ordered colors",
      description: "",
      steps: [
        { id: "a", schemeId: first.id, enabled: true },
        { id: "b", schemeId: second.id, enabled: true },
      ],
    };
    await f.rules.saveSequence(sequence);
    const prepared = await f.prepare(
        await f.reference("sequence", sequence.id),
      ),
      id = batchId(prepared);
    await f.rules.saveSequence({
      ...sequence,
      steps: [...sequence.steps].reverse(),
    });
    expect((await f.action(id, "apply")).status).toBe("failed");
    expect(f.notifySaved).not.toHaveBeenCalled();
    const fresh = batchId(
      await f.prepare(await f.reference("sequence", sequence.id)),
    );
    expect((await f.action(fresh, "apply")).status).toBe("completed");
    expect(
      (await f.library.openChapter("chapter")).pages[0].blocks[0].textColor,
    ).toBe("#123456");
    expect(f.runtime.create).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects changed resource versions and absent groups; undo survives resource deletion", async () => {
  const f = await letteringResourcesFixture();
  try {
    const preset = f.preset("versioned", "Versioned", ["color"], {
      textColor: "#abcdef",
    });
    await f.setPresets([preset]);
    const ref = await f.reference("preset", preset.id);
    for (const groupIds of [["font"], ["color", "color"]]) {
      const invalid = await f.prepare({ ...ref, groupIds });
      expect(invalid.job.status).toBe("failed");
      expect(invalid.batchId).toBeUndefined();
    }
    const id = batchId(await f.prepare(ref));
    await f.setPresets([{ ...preset, name: "Renamed" }]);
    expect((await f.action(id, "apply")).status).toBe("failed");
    const fresh = batchId(
      await f.prepare(await f.reference("preset", preset.id)),
    );
    expect((await f.action(fresh, "apply")).status).toBe("completed");
    await f.setPresets([]);
    expect((await f.action(fresh, "undo")).status).toBe("completed");
    expect((await f.action(fresh, "redo")).status).toBe("failed");
  } finally {
    await f.close();
  }
});

it("keeps an acknowledged first commit and stops the next if a saved resource changes mid-batch", async () => {
  const f = await letteringResourcesFixture();
  const before = await f.library.openChapter("chapter");
  try {
    const preset = f.preset("midway", "Midway", ["color"], {
      textColor: "#abcdef",
    });
    await f.setPresets([preset]);
    const id = batchId(await f.prepare(await f.reference("preset", preset.id)));
    f.notifySaved.mockImplementationOnce(() => {
      const settings = JSON.parse(
        readFileSync(f.app.appPaths.settingsPath, "utf8"),
      );
      settings.blockStylePresets = [];
      writeFileSync(f.app.appPaths.settingsPath, JSON.stringify(settings));
    });
    const result = await f.action(id, "apply");
    expect(result.status).toBe("partial");
    const after = await f.library.openChapter("chapter");
    expect(after.pages[0].blocks[0].textColor).toBe("#abcdef");
    expect(after.pages[1].blocks).toEqual(before.pages[1].blocks);
    expect((await f.action(id, "undo")).status).toBe("completed");
    expect(
      (await f.library.openChapter("chapter")).pages.map((page) => page.blocks),
    ).toEqual(before.pages.map((page) => page.blocks));
  } finally {
    await f.close();
  }
});
