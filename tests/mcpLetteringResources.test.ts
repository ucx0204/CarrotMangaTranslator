import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { letteringResourcesFixture } from "./mcpLetteringResources.fixture";
import { mcpLetteringResourceOutputs } from "../src/shared/mcpLetteringResources";
import { createCurvePreset } from "../src/shared/blockTransformPresets";

it("returns native presets and block styles without images, template text, settings or usage writes", async () => {
  const f = await letteringResourcesFixture();
  try {
    const preset = f.preset(
      "fixture:preset",
      "Blue shadow",
      ["color", "effect"],
      {
        textColor: "#123456",
        textGlow: { enabled: true, color: "#fedcba", blurPx: 7, opacity: 0.8 },
      },
    );
    await f.setPresets([preset]);
    const block = await f.addBlockStyle({
      curveLayout: createCurvePreset("archUp"),
    });
    const beforeSettings = await readFile(f.app.appPaths.settingsPath);
    const beforeBlocks = await readFile(f.blocks.filePath);
    const beforePage = await readFile(f.chapterPath);
    for (const [resourceKind, id] of [
      ["preset", preset.id],
      ["block-style", block.id],
    ] as const) {
      const ref = await f.reference(resourceKind, id);
      const result = await f.resources.get(
        { resourceKind, id, snapshot: ref.snapshot },
        () => {},
      );
      expect(
        mcpLetteringResourceOutputs.carrot_get_lettering_resource.safeParse(
          result,
        ).success,
      ).toBe(true);
      expect(result.supported).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(
        /PRIVATE_|dataUrl|referencePageSize|secretGeneration|imagePath|settingsPath/,
      );
      expect(result.formatJson).toBeTruthy();
      expect((await f.reference(resourceKind, id)).snapshot).toBe(ref.snapshot);
    }
    expect(await readFile(f.app.appPaths.settingsPath)).toEqual(beforeSettings);
    expect(await readFile(f.blocks.filePath)).toEqual(beforeBlocks);
    expect(await readFile(f.chapterPath)).toEqual(beforePage);
    await expect(
      access(join(f.app.appPaths.dataRoot, "settings.commit.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.runtime.create).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("requires list and item snapshots independently and never mixes changed resource pages", async () => {
  const f = await letteringResourcesFixture();
  try {
    const presets = [
      f.preset("one", "First", ["color"], { textColor: "#123456" }),
      f.preset("two", "Second", ["color"], { textColor: "#abcdef" }),
    ];
    await f.setPresets(presets);
    const first = await f.resources.list(
      { resourceKind: "preset", limit: 1 },
      () => {},
    );
    expect(first.nextOffset).toBe(1);
    await expect(
      f.resources.list({ resourceKind: "preset", offset: 1 }, () => {}),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    const second = await f.resources.list(
      { resourceKind: "preset", offset: 1, limit: 1, snapshot: first.snapshot },
      () => {},
    );
    expect(second.resources[0].id).toBe("two");
    const ref = await f.reference("preset", "one");
    await f.setPresets([{ ...presets[0], name: "Renamed" }, presets[1]]);
    await expect(
      f.resources.list(
        {
          resourceKind: "preset",
          offset: 1,
          limit: 1,
          snapshot: first.snapshot,
        },
        () => {},
      ),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(
      f.resources.get(
        { resourceKind: "preset", id: ref.id, snapshot: ref.snapshot },
        () => {},
      ),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(
      (
        await f.resources.list(
          { resourceKind: "preset", query: "RENAMED" },
          () => {},
        )
      ).total,
    ).toBe(1);
    expect(
      (
        await f.resources.list(
          { resourceKind: "preset", query: "[.*]" },
          () => {},
        )
      ).total,
    ).toBe(0);
    await f.setPresets([]);
    await expect(
      f.resources.get(
        { resourceKind: "preset", id: ref.id, snapshot: ref.snapshot },
        () => {},
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  } finally {
    await f.close();
  }
});

it("returns enabled sequence steps in saved order and rejects non-lettering actions without silently skipping", async () => {
  const f = await letteringResourcesFixture();
  try {
    const make = async (
      name: string,
      field: "sourceText" | "bold" | "italic",
    ) => {
      const saved = await f.rules.save({
        scheme: {
          name,
          match: { mode: "allBlocks", conditions: [], groups: [] },
          description: "",
          actions: [
            {
              id: "set",
              type: "setFields",
              enabled: true,
              changes: [
                {
                  field,
                  operation: "set",
                  value: field === "sourceText" ? "forbidden" : true,
                },
              ],
            },
          ],
        },
      });
      const rule = saved.schemes.find((entry) => entry.name === name);
      if (!rule) throw new Error("Missing rule");
      return rule;
    };
    const first = await make("First", "bold"),
      second = await make("Second", "italic"),
      unsupported = await make("Not lettering", "sourceText");
    await f.rules.saveSequence({
      id: "sequence",
      name: "Ordered",
      description: "",
      steps: [
        { id: "s2", schemeId: second.id, enabled: true },
        { id: "skip", schemeId: unsupported.id, enabled: false },
        { id: "s1", schemeId: first.id, enabled: true },
      ],
    });
    const ref = await f.reference("sequence", "sequence");
    const page = await f.resources.get(
      {
        resourceKind: ref.resourceKind,
        id: ref.id,
        snapshot: ref.snapshot,
        offset: 0,
        limit: 1,
      },
      () => {},
    );
    expect(page.supported).toBe(true);
    expect(page.steps[0].name).toBe("Second");
    expect(page.nextOffset).toBe(1);
    const next = await f.resources.get(
      {
        resourceKind: ref.resourceKind,
        id: ref.id,
        snapshot: ref.snapshot,
        offset: 1,
        limit: 1,
      },
      () => {},
    );
    expect(next.steps[0].name).toBe("First");
    expect(next.nextOffset).toBeNull();
    const bad = await f.reference("rule", unsupported.id);
    expect(
      (
        await f.resources.get(
          {
            resourceKind: bad.resourceKind,
            id: bad.id,
            snapshot: bad.snapshot,
          },
          () => {},
        )
      ).supported,
    ).toBe(false);
    await expect(f.resources.resolve(bad, () => {})).rejects.toMatchObject({
      code: "invalid_edit",
    });
    const { id: firstId, ...firstDraft } = first;
    await f.rules.save({
      id: firstId,
      scheme: {
        ...firstDraft,
        actions: [
          {
            id: "new",
            type: "setFields",
            enabled: true,
            changes: [{ field: "italic", operation: "set", value: false }],
          },
        ],
      },
    });
    await expect(f.resources.resolve(ref, () => {})).rejects.toMatchObject({
      code: "revision_conflict",
    });
  } finally {
    await f.close();
  }
});

it("keeps missing native files absent and propagates malformed stores instead of returning fake emptiness", async () => {
  const f = await letteringResourcesFixture();
  try {
    expect(
      (await f.resources.list({ resourceKind: "preset" }, () => {})).total,
    ).toBe(0);
    expect(
      (await f.resources.list({ resourceKind: "block-style" }, () => {})).total,
    ).toBe(0);
    await f.resources.list({ resourceKind: "rule" }, () => {});
    await expect(access(f.rules.filePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(f.blocks.filePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeFile(f.rules.filePath, "broken: [unterminated");
    await expect(
      f.resources.list({ resourceKind: "rule" }, () => {}),
    ).rejects.toThrow();
    expect(await readFile(f.rules.filePath, "utf8")).toBe(
      "broken: [unterminated",
    );
  } finally {
    await f.close();
  }
});
