import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { letteringFixture } from "./mcpLettering.fixture";
import { McpLetteringPrepareSchema } from "../src/shared/mcpLettering";
import {
  createCurvePreset,
  createPerspectivePreset,
} from "../src/shared/blockTransformPresets";
import { createConditionalLiteralMatcher } from "../src/shared/conditionalTextPattern";
import { parseRichText } from "../src/shared/richTextMarkup";

it("plans without writes, applies native styles, and restores exact optional state", async () => {
  const f = letteringFixture();
  const before = structuredClone(f.chapter);
  try {
    const plan = await f.service.preview(f.owner, f.request(), f.guard);
    expect(f.save).not.toHaveBeenCalled();
    expect(JSON.stringify(await f.inspect(plan.batchId))).not.toMatch(
      /imagePath|PRIVATE|dataUrl|beforeBlock/,
    );
    f.start(plan.batchId, "apply");
    expect((await f.done(plan.batchId)).status).toBe("completed");
    expect(f.chapter.pages[0].blocks[0]).toMatchObject({
      bold: true,
      textGlow: { enabled: true, blurPx: 5 },
    });
    expect(f.chapter.pages[0].blocks[1]).toEqual(before.pages[0].blocks[1]);
    const changed = structuredClone(f.chapter.pages);
    f.start(plan.batchId, "undo");
    expect((await f.done(plan.batchId)).status).toBe("completed");
    expect(f.chapter).toEqual(before);
    expect(Object.hasOwn(f.chapter.pages[0].blocks[0], "textGlow")).toBe(false);
    f.start(plan.batchId, "redo");
    await f.done(plan.batchId);
    expect(f.chapter.pages).toEqual(changed);
  } finally {
    await f.close();
  }
});

it("uses safe native perspective/curve contracts and exact clear/undo", async () => {
  const f = letteringFixture();
  f.chapter.pages[0].blocks[0].curveLayout = createCurvePreset("archUp");
  const before = structuredClone(f.chapter.pages);
  try {
    const input = f.request({
      kind: "format",
      advanced: {
        perspectiveTransform: createPerspectivePreset("topNarrow"),
        curveLayout: null,
      },
    });
    const plan = await f.service.preview(f.owner, input, f.guard);
    f.start(plan.batchId, "apply");
    await f.done(plan.batchId);
    expect(f.chapter.pages[0].blocks[0].curveLayout).toBeUndefined();
    expect(f.chapter.pages[0].blocks[0].perspectiveTransform).toEqual(
      createPerspectivePreset("topNarrow"),
    );
    f.start(plan.batchId, "undo");
    await f.done(plan.batchId);
    expect(f.chapter.pages).toEqual(before);
    expect(() =>
      McpLetteringPrepareSchema.parse({
        ...input,
        command: {
          kind: "format",
          advanced: {
            perspectiveTransform: {
              version: 1,
              corners: [
                { x: 0, y: 0 },
                { x: 0, y: 0 },
                { x: 0, y: 0 },
                { x: 0, y: 0 },
              ],
            },
          },
        },
      }),
    ).toThrow();
  } finally {
    await f.close();
  }
});

it("applies native partial rich text styles without changing visible text", async () => {
  const f = letteringFixture();
  for (const page of f.chapter.pages)
    page.blocks[0].translatedText = "hello world hello";
  const before = structuredClone(f.chapter.pages);
  const scheme = {
    name: "Partial emphasis",
    description: "",
    match: { mode: "allBlocks", conditions: [], groups: [] },
    actions: [
      {
        id: "style",
        type: "styleText",
        enabled: true,
        target: "translatedText",
        scope: "pattern",
        matcher: createConditionalLiteralMatcher("hello"),
        allOccurrences: true,
        styleMode: "overwrite",
        patch: { bold: true, color: "#123456" },
      },
    ],
  };
  try {
    const plan = await f.service.preview(
      f.owner,
      f.request({ kind: "rule", schemeJson: JSON.stringify(scheme) }),
      f.guard,
    );
    f.start(plan.batchId, "apply");
    expect((await f.done(plan.batchId)).status).toBe("completed");
    const parsed = parseRichText(f.chapter.pages[0].blocks[0].translatedText);
    expect(parsed.plainText).toBe("hello world hello");
    expect(
      parsed.runs
        .filter((run) => run.text === "hello")
        .every((run) => run.bold && run.color === "#123456"),
    ).toBe(true);
    f.start(plan.batchId, "undo");
    await f.done(plan.batchId);
    expect(f.chapter.pages).toEqual(before);
  } finally {
    await f.close();
  }
});

it.each(["sourceText", "translatedText", "speakerId", "reviewStatus"])(
  "rejects a %s rule outside lettering scope",
  async (field) => {
    const f = letteringFixture();
    const scheme = {
      name: "Wrong scope",
      match: { mode: "allBlocks" },
      actions: [
        {
          id: "edit",
          type: "setFields",
          enabled: true,
          changes: [
            {
              field,
              operation: "set",
              value: field === "reviewStatus" ? "reviewed" : "changed",
            },
          ],
        },
      ],
    };
    try {
      await expect(
        f.service.preview(
          f.owner,
          f.request({ kind: "rule", schemeJson: JSON.stringify(scheme) }),
          f.guard,
        ),
      ).rejects.toThrow();
      expect(f.save).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it("protects manual size while applying requested non-size style", async () => {
  const f = letteringFixture();
  f.chapter.pages[0].blocks[0].fontSizeIntent = "manual";
  const size = f.chapter.pages[0].blocks[0].fontSizePx;
  try {
    const plan = await f.service.preview(
      f.owner,
      f.request({ kind: "format", fields: { fontSizePx: 48, italic: true } }),
      f.guard,
    );
    f.start(plan.batchId, "apply");
    await f.done(plan.batchId);
    expect(f.chapter.pages[0].blocks[0].fontSizePx).toBe(size);
    expect(f.chapter.pages[0].blocks[0].italic).toBe(true);
    expect(f.chapter.pages[1].blocks[0].fontSizePx).toBe(48);
  } finally {
    await f.close();
  }
});

it("keeps partial saves, acknowledges them before notification failure and prevents duplicate reapplication", async () => {
  const f = letteringFixture();
  const before = structuredClone(f.chapter.pages);
  f.notify.mockImplementationOnce(() => {
    throw new Error("notification failed");
  });
  try {
    const plan = await f.service.preview(f.owner, f.request(), f.guard);
    const action = randomUUID();
    f.start(plan.batchId, "apply", action);
    const result = await f.done(plan.batchId);
    expect(result.status).toBe("partial");
    expect(result.pages[0].state).toBe("applied");
    expect(f.start(plan.batchId, "apply", action).historical).toBe(true);
    expect(f.save).toHaveBeenCalledOnce();
    f.start(plan.batchId, "undo");
    await f.done(plan.batchId);
    expect(f.chapter.pages).toEqual(before);
  } finally {
    await f.close();
  }
});

it("does not publish plans after shutdown and refuses other-owner histories or later user edits", async () => {
  const f = letteringFixture();
  try {
    const plan = await f.service.preview(f.owner, f.request(), f.guard);
    await expect(
      f.service.inspect("other", { batchId: plan.batchId }, f.guard),
    ).rejects.toMatchObject({ code: "not_found" });
    f.start(plan.batchId, "apply");
    await f.done(plan.batchId);
    f.chapter.pages[0].blocks[0].translatedText = "new user text";
    f.start(plan.batchId, "undo");
    expect((await f.done(plan.batchId)).status).toBe("failed");
    expect(f.chapter.pages[0].blocks[0].translatedText).toBe("new user text");
    f.lifetime.abort();
    await expect(
      f.service.preview(f.owner, f.request(), f.guard),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});
