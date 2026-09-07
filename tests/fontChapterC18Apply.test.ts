import { describe, expect, it } from "vitest";
import { resolveAutomaticFontDecisionV2 } from "../src/main/pipeline/automaticFontMatchingV2";
import { applyAutomaticFontDecisionV2 } from "../src/main/pipeline/automaticFontMatchingV2Apply";
import {
  createAutomaticFontChapterCoordinatorV2,
  createAutomaticFontPageCoordinatorV2,
} from "../src/main/pipeline/automaticFontMatchingV2PageCoordinator";
import { fontChapterItemIdentity } from "../src/main/pipeline/fontChapterC18Input";
import type { FontChapterC18Style } from "../src/main/pipeline/fontChapterC18Types";
import {
  builtIn,
  makeBlock,
  makeItem,
  makePage,
  makeProfile,
} from "./helpers/automaticFontMatchingV2Fixtures";

const style: FontChapterC18Style = {
  fontId: "jua",
  fontWeight: 400,
  italic: false,
  groupId: "source-group",
  runtimeVersion: "c18.1",
};

function run({ available = true, locked = false, enabled = true } = {}) {
  const block = makeBlock();
  const page = makePage();
  const item = makeItem("dialogue", 1);
  const chapter = {
    ...createAutomaticFontChapterCoordinatorV2(),
    sourceStyleFor: () => style,
  };
  const profile = makeProfile();
  if (locked)
    profile.userLocks.push({
      id: "manual",
      scope: {
        type: "block",
        chapterId: "chapter-a",
        pageId: page.id,
        blockId: block.id,
      },
      selection: { fontId: "dohyeon", fontWeight: 400 },
      createdAt: "",
      updatedAt: "",
    });
  const decision = resolveAutomaticFontDecisionV2({
    block,
    page,
    item,
    options: {
      enabled,
      targetLanguage: "ko",
      workId: profile.workId,
      chapterId: "chapter-a",
      profile,
      candidates: available
        ? [builtIn("jua"), builtIn("dohyeon")]
        : [builtIn("dohyeon")],
      pageCoordinator: createAutomaticFontPageCoordinatorV2({
        chapterCoordinator: chapter,
      }),
    },
  });
  return { decision, block: applyAutomaticFontDecisionV2(block, decision) };
}

describe("C18 through the real automatic decision/application boundaries", () => {
  it("carries the chapter family and regular weight through the page coordinator", () => {
    const result = run();
    expect(result.decision?.sourceChapterStyle).toEqual(style);
    expect(result.block).toMatchObject({
      fontFamily: "jua",
      fontWeight: 400,
      bold: false,
      italic: false,
    });
    expect(result.decision?.fontMetricWidthScale).toBeUndefined();
  });
  it("respects manual locks and an unavailable font pool", () => {
    expect(run({ locked: true }).decision?.sourceChapterStyle).toBeUndefined();
    expect(
      run({ available: false }).decision?.sourceChapterStyle,
    ).toBeUndefined();
  });
  it("does not apply chapter matching when automatic matching is off", () => {
    expect(run({ enabled: false }).decision).toBeUndefined();
  });
  it("binds source geometry and writing but does not bind translated wording", () => {
    const item = makeItem("dialogue", 1);
    const identity = fontChapterItemIdentity(item);
    expect(
      fontChapterItemIdentity({
        ...item,
        bbox: {
          h: item.bbox.h,
          w: item.bbox.w,
          y: item.bbox.y,
          x: item.bbox.x,
        },
      }),
    ).toBe(identity);
    expect(fontChapterItemIdentity({ ...item, ko: "새 번역" })).toBe(identity);
    expect(fontChapterItemIdentity({ ...item, sourceText: "別" })).not.toBe(
      identity,
    );
    expect(
      fontChapterItemIdentity({
        ...item,
        bbox: { ...item.bbox, x: item.bbox.x + 1 },
      }),
    ).not.toBe(identity);
  });
});
