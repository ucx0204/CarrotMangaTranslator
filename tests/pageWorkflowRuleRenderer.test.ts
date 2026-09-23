import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installWorkflowRuleRenderer } from "../src/renderer/src/pageExport/workflowRules";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import {
  createConditionalBatchRecipeDraft,
  createBlankBatchSchemeDraft,
} from "../src/shared/conditionalBatchRules";
import type {
  PageWorkflowRuleRenderRequest,
  PageWorkflowRuleRenderResult,
} from "../src/shared/pageWorkflowTypes";
import { makeChapter, makePage } from "./helpers/workspacePointerFixtures";

let applyRules: (
  request: PageWorkflowRuleRenderRequest,
) => Promise<PageWorkflowRuleRenderResult>;
beforeEach(() => {
  const target: { applyWorkflowRules?: typeof applyRules } = {};
  vi.stubGlobal("window", target);
  vi.stubGlobal("document", {
    fonts: { load: async () => [{ family: "Fixture" }] },
    createElement: () => ({
      getContext: () => ({
        font: "",
        measureText(this: { font: string }, text: string) {
          const size = Number(/([\d.]+)px/u.exec(this.font)?.[1] ?? 16);
          return {
            width: text.length * size,
            actualBoundingBoxAscent: size * 0.8,
            actualBoundingBoxDescent: size * 0.2,
            actualBoundingBoxLeft: 0,
            actualBoundingBoxRight: size,
          };
        },
      }),
    }),
  });
  installWorkflowRuleRenderer(DEFAULT_BLOCK_FONT_CATALOG);
  if (!target.applyWorkflowRules) throw new Error("Renderer not installed");
  applyRules = target.applyWorkflowRules;
});
afterEach(() => vi.unstubAllGlobals());

describe("production workflow rule renderer", () => {
  it("applies frozen rules in sequence using the existing batch engine", async () => {
    const chapter = makeChapter(
      makePage({ blockPatch: { translatedText: "a" } }),
    );
    const result = await applyRules({
      chapter,
      pageId: chapter.pages[0].id,
      glossary: [],
      inspect: false,
      schemes: [
        createConditionalBatchRecipeDraft("findReplace", {
          find: "a",
          replace: "aa",
        }),
        createConditionalBatchRecipeDraft("findReplace", {
          find: "aa",
          replace: "done",
        }),
      ],
    });
    expect(result.chapter.pages[0].blocks[0].translatedText).toBe("done");
    expect(chapter.pages[0].blocks[0].translatedText).toBe("a");
  });
  it("uses rendered source-match size for conditions instead of the stored nominal seed", async () => {
    const chapter = makeChapter(
      makePage({
        blockPatch: {
          translatedText: "가나다",
          fontSizePx: 40,
          fontSizeIntent: "source-match",
          sourceFontFacePx: 11,
          sourceFontSizeConfidence: 0.9,
          sourceFontSizeMethod: "raster-core-v1",
          autoFitText: false,
        },
      }),
    );
    const scheme = createBlankBatchSchemeDraft();
    scheme.match = {
      mode: "all",
      groups: [],
      conditions: [
        {
          id: "small",
          enabled: true,
          field: "fontSizePx",
          operator: "lessThan",
          value: 25,
        },
      ],
    };
    scheme.actions = [
      {
        id: "mark",
        enabled: true,
        type: "setFields",
        changes: [
          { field: "translatedText", operation: "set", value: "measured" },
        ],
      },
    ];
    const result = await applyRules({
      chapter,
      pageId: chapter.pages[0].id,
      glossary: [],
      inspect: false,
      schemes: [scheme],
    });
    expect(result.chapter.pages[0].blocks[0].translatedText).toBe("measured");
  });
  it("keeps unanswered dialogue visible to review without failing or rewriting the page", async () => {
    const page = makePage({
      blockPatch: { sourceText: "読める台詞", translatedText: "" },
    });
    page.analysisStatus = "completed";
    page.blocks.push({
      ...page.blocks[0],
      id: "translated",
      translatedText: "번역 완료",
    });
    const chapter = makeChapter(page);
    const result = await applyRules({
      chapter,
      pageId: page.id,
      glossary: [],
      inspect: true,
      schemes: [createConditionalBatchRecipeDraft("emptyTranslation")],
    });
    expect(result.chapter).toEqual(chapter);
    expect(result.findings.map((finding) => finding.blockId)).toEqual([
      page.blocks[0].id,
    ]);
    expect(result.chapter.pages[0].analysisStatus).toBe("completed");
  });

  it("reports review findings without changing text or marking review complete", async () => {
    const chapter = makeChapter(
      makePage({ blockPatch: { sourceText: "same", translatedText: "same" } }),
    );
    const result = await applyRules({
      chapter,
      pageId: chapter.pages[0].id,
      glossary: [],
      inspect: true,
      schemes: [createConditionalBatchRecipeDraft("sameAsSource")],
    });
    expect(result.chapter).toEqual(chapter);
    expect(result.findings.map((finding) => finding.blockId)).toEqual([
      chapter.pages[0].blocks[0].id,
    ]);
    expect(result.chapter.pages[0].blocks[0].reviewStatus).toBeUndefined();
  });
});
