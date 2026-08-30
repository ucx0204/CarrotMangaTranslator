/** @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useStatusLog } from "../src/renderer/src/hooks/useStatusLog";
import type { ChapterSnapshot, LibraryIndex } from "../src/shared/libraryTypes";

const TS = "2026-01-01T00:00:00.000Z";
const library: LibraryIndex = {
  workOrder: ["work-1"],
  works: [
    {
      id: "work-1",
      title: "샘플 작품",
      chapterOrder: ["chapter-1", "chapter-2"],
      chapters: [
        makeChapterSummary("chapter-1", "1화"),
        makeChapterSummary("chapter-2", "2화"),
      ],
      createdAt: TS,
      updatedAt: TS,
    },
  ],
};

describe("status log session history", () => {
  it("keeps every line in memory and starts empty after remounting", () => {
    const first = renderHook(() => useStatusLog());

    act(() => {
      for (let index = 1; index <= 40; index += 1) {
        first.result.current.appendStatusLine(`상태 기록 ${index}`);
      }
    });

    expect(first.result.current.statusLines).toHaveLength(40);
    expect(first.result.current.statusLines[0]).toBe("상태 기록 40");
    expect(first.result.current.statusLines[39]).toBe("상태 기록 1");

    first.unmount();
    const restarted = renderHook(() => useStatusLog());
    expect(restarted.result.current.statusLines).toEqual([]);
  });

  it("keeps prior chapter records while replacing progress in the current chapter", () => {
    const firstChapter = makeChapter("chapter-1", "1화");
    const secondChapter = makeChapter("chapter-2", "2화");
    const view = renderHook(
      ({ currentChapter }) => useStatusLog({ currentChapter, library }),
      { initialProps: { currentChapter: firstChapter } },
    );
    const replaceOcr = (line: string) => line.includes("Paddle OCR");

    act(() => {
      view.result.current.appendStatusLine(
        "Paddle OCR 배치 선분석 중",
        replaceOcr,
      );
      view.result.current.appendStatusLine(
        "Paddle OCR 선분석 완료",
        replaceOcr,
      );
    });
    view.rerender({ currentChapter: secondChapter });
    act(() => {
      view.result.current.appendStatusLine(
        "Paddle OCR 선분석 완료",
        replaceOcr,
      );
    });

    expect(view.result.current.statusLines).toEqual([
      "Paddle OCR 선분석 완료",
      "Paddle OCR 선분석 완료",
    ]);
    expect(
      view.result.current.statusEntries.map((entry) => entry.context),
    ).toEqual([
      {
        chapterId: "chapter-2",
        chapterTitle: "2화",
        workTitle: "샘플 작품",
      },
      {
        chapterId: "chapter-1",
        chapterTitle: "1화",
        workTitle: "샘플 작품",
      },
    ]);
  });
});

function makeChapter(id: string, title: string): ChapterSnapshot {
  return {
    id,
    workId: "work-1",
    title,
    sourceKind: "images",
    status: "idle",
    pageOrder: [],
    pages: [],
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeChapterSummary(id: string, title: string) {
  return {
    id,
    workId: "work-1",
    title,
    status: "idle" as const,
    pageCount: 40,
    createdAt: TS,
    updatedAt: TS,
  };
}
