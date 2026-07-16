// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChapterStoryMemory } from "../src/shared/workContextTypes";
import { MemoryTab } from "../src/renderer/src/components/styleGuide/MemoryTab";

const TS = "2026-01-01T00:00:00.000Z";

function makeMemory(visualSummary = "창가에서 두 사람이 대화한다.") {
  return {
    schemaVersion: 1,
    workId: "work-1",
    chapterId: "chapter-1",
    updatedAt: TS,
    pages: [
      {
        pageId: "page-1",
        pageName: "001.png",
        pageIndex: 0,
        sourceDigest: "source",
        translatedDigest: "translated",
        summary: "기존 텍스트 요약",
        visualSummary,
        visualSummarySource: "ai",
        updatedAt: TS,
      },
    ],
  } satisfies ChapterStoryMemory;
}

afterEach(cleanup);

describe("MemoryTab", () => {
  it("shows the visual summary before the text fallback and marks edits manual", () => {
    const onMemoryChange = vi.fn();
    render(<MemoryTab memory={makeMemory()} onMemoryChange={onMemoryChange} />);

    const summary = screen.getByRole("textbox");
    expect(summary).toHaveProperty("value", "창가에서 두 사람이 대화한다.");
    expect((summary as HTMLTextAreaElement).maxLength).toBe(1200);
    expect(screen.getByText("기존 텍스트 요약")).toBeTruthy();

    fireEvent.change(summary, { target: { value: "복도에서 달려간다." } });

    expect(onMemoryChange).toHaveBeenCalledWith(
      expect.objectContaining({
        pages: [
          expect.objectContaining({
            pageId: "page-1",
            visualSummary: "복도에서 달려간다.",
            visualSummarySource: "manual",
            updatedAt: expect.not.stringMatching(/^2026-01-01/),
          }),
        ],
        updatedAt: expect.not.stringMatching(/^2026-01-01/),
      }),
    );
  });

  it("keeps a cleared summary protected as a manual edit", () => {
    const onMemoryChange = vi.fn();
    render(<MemoryTab memory={makeMemory()} onMemoryChange={onMemoryChange} />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "" },
    });

    expect(onMemoryChange).toHaveBeenCalledWith(
      expect.objectContaining({
        pages: [
          expect.objectContaining({
            visualSummary: undefined,
            visualSummarySource: "manual",
          }),
        ],
      }),
    );
  });
});
