import { describe, expect, it } from "vitest";
import {
  parseIpcPayload,
  StartAnalysisRequestSchema,
} from "../src/shared/ipcSchemas";
import { MAX_ID_LIST_LENGTH } from "../src/shared/ipcSchemaPrimitives";

const chapterId = "22222222-2222-4222-8222-222222222222";
const pageId = "33333333-3333-4333-8333-333333333333";
const secondPageId = "44444444-4444-4444-8444-444444444444";

describe("resumable analysis IPC schema", () => {
  it("accepts page-level restart intent", () => {
    const parsed = parseIpcPayload(
      StartAnalysisRequestSchema,
      {
        chapterId,
        runMode: "page-set",
        pageIds: [pageId, secondPageId],
        restartPageIds: [secondPageId],
      },
      "번역 작업",
    );
    expect(parsed).toMatchObject({
      runMode: "page-set",
      pageIds: [pageId, secondPageId],
      restartPageIds: [secondPageId],
    });
  });

  it("rejects restart ids outside the selection or duplicated ids", () => {
    expect(() =>
      parseIpcPayload(
        StartAnalysisRequestSchema,
        {
          chapterId,
          runMode: "page-set",
          pageIds: [pageId],
          restartPageIds: [secondPageId],
        },
        "번역 작업",
      ),
    ).toThrow(/재번역 페이지는 선택된 페이지에 포함/);
    expect(() =>
      parseIpcPayload(
        StartAnalysisRequestSchema,
        {
          chapterId,
          runMode: "page-set",
          pageIds: [pageId],
          restartPageIds: [pageId, pageId],
        },
        "번역 작업",
      ),
    ).toThrow(/중복된 재번역 페이지 ID/);
  });

  it("keeps the existing page-set bounds and path validation", () => {
    const invalidPageIds = [[], ["../escape"], [pageId, pageId]];
    for (const pageIds of invalidPageIds) {
      expect(() =>
        parseIpcPayload(
          StartAnalysisRequestSchema,
          { chapterId, runMode: "page-set", pageIds },
          "번역 작업",
        ),
      ).toThrow();
    }
    expect(() =>
      parseIpcPayload(
        StartAnalysisRequestSchema,
        { chapterId, runMode: "page-set", pageIds: [pageId], pageId },
        "번역 작업",
      ),
    ).toThrow(/요청 형식/);
    const excessivePageIds = Array.from(
      { length: MAX_ID_LIST_LENGTH + 1 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    expect(() =>
      parseIpcPayload(
        StartAnalysisRequestSchema,
        { chapterId, runMode: "page-set", pageIds: excessivePageIds },
        "번역 작업",
      ),
    ).toThrow(/요청 형식/);
  });
});
