// @vitest-environment jsdom

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharactersTab } from "../src/renderer/src/components/styleGuide/CharactersTab";
import { GlossaryTab } from "../src/renderer/src/components/styleGuide/GlossaryTab";
import { StyleGuideTabContent } from "../src/renderer/src/components/styleGuide/StyleGuideChrome";
import type { WorkStyleGuide } from "../src/shared/workContextTypes";
import type { WorkContextUsageMetric } from "../src/shared/workContextUsageTypes";

const TS = "2026-01-01T00:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("style guide usage management", () => {
  it("sorts, filters, edits, and bulk-deletes glossary entries by stable ID", () => {
    const guide = makeGuide();
    const onGuideChange = vi.fn();
    render(
      <GlossaryTab
        guide={guide}
        onGuideChange={onGuideChange}
        usage={makeUsage()}
      />,
    );

    expect(glossarySourceOrder()).toEqual(["Beta", "Alpha"]);

    fireEvent.change(screen.getByLabelText("정렬"), {
      target: { value: "name" },
    });
    expect(glossarySourceOrder()).toEqual(["Alpha", "Beta"]);

    fireEvent.change(screen.getByLabelText("필터"), {
      target: { value: "ai" },
    });
    expect(glossarySourceOrder()).toEqual(["Beta"]);

    fireEvent.change(screen.getByPlaceholderText("원문"), {
      target: { value: "Beta edited" },
    });
    expect(onGuideChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        glossary: [
          expect.objectContaining({ id: "alpha", source: "Alpha" }),
          expect.objectContaining({
            id: "beta",
            source: "Beta edited",
            origin: "manual",
          }),
        ],
      }),
    );

    fireEvent.change(screen.getByLabelText("필터"), {
      target: { value: "all" },
    });
    fireEvent.click(screen.getByLabelText("Alpha 선택"));
    fireEvent.click(screen.getByLabelText("Beta 선택"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "2개 삭제" }));
    expect(onGuideChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ glossary: [] }),
    );
  });

  it("supports usage sorting and ID-based character edits", () => {
    const guide = makeGuide();
    const onGuideChange = vi.fn();
    render(
      <CharactersTab
        guide={guide}
        onGuideChange={onGuideChange}
        usage={makeCharacterUsage()}
      />,
    );

    const names = screen
      .getAllByPlaceholderText("표시 이름")
      .map((input) => (input as HTMLInputElement).value);
    expect(names).toEqual(["유나", "민호"]);

    fireEvent.change(screen.getAllByPlaceholderText("표시 이름")[0], {
      target: { value: "유나 수정" },
    });
    expect(onGuideChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        characters: [
          expect.objectContaining({ id: "minho", displayName: "민호" }),
          expect.objectContaining({
            id: "yuna",
            displayName: "유나 수정",
            origin: "manual",
          }),
        ],
      }),
    );
  });

  it("shows only the mention count and keeps detailed usage in a tooltip", () => {
    const onGuideChange = vi.fn();
    render(
      <GlossaryTab
        guide={makeGuide()}
        onGuideChange={onGuideChange}
        usage={makeUsage()}
      />,
    );

    const betaSource = screen.getAllByPlaceholderText("원문")[0];
    const betaRow = betaSource.closest(".style-guide-row");
    expect(betaRow).not.toBeNull();
    const row = within(betaRow as HTMLElement);
    expect(screen.getByText("횟수")).toBeTruthy();
    expect(
      row.getByText("7").classList.contains("style-guide-usage-number"),
    ).toBe(true);
    expect(row.getByRole("tooltip").textContent).toBe(
      "5쪽 · 7회 · 최근 1화 5쪽",
    );
    expect(row.getAllByRole("checkbox")).toHaveLength(1);

    const enabled = row.getByRole("switch", { name: "Beta 활성화" });
    expect(enabled.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(enabled);
    expect(onGuideChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        glossary: expect.arrayContaining([
          expect.objectContaining({
            id: "beta",
            enabled: false,
            origin: "manual",
          }),
        ]),
      }),
    );

    fireEvent.click(row.getByRole("button", { name: "Beta 삭제" }));
    expect(onGuideChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        glossary: [expect.objectContaining({ id: "alpha" })],
      }),
    );
  });

  it("keeps usage as the default sort while statistics transition from loading to ready", () => {
    const guide = makeGuide();
    const props = {
      busy: false,
      guide,
      memory: null,
      onGuideChange: vi.fn(),
      onMemoryChange: vi.fn(),
      tab: "glossary" as const,
    };
    const { rerender } = render(
      <StyleGuideTabContent {...props} usage={null} usageStatus="loading" />,
    );

    rerender(
      <StyleGuideTabContent
        {...props}
        usage={{ workId: guide.workId, glossary: makeUsage(), characters: [] }}
        usageStatus="ready"
      />,
    );

    expect(glossarySourceOrder()).toEqual(["Beta", "Alpha"]);
    expect(screen.getByLabelText("정렬")).toHaveProperty("value", "usage");
  });

  it("supports search, remaining sorts and usage filters", () => {
    const guide = makeGuide();
    guide.glossary.push({
      ...guide.glossary[0],
      id: "gamma",
      source: "Gamma",
      target: "감마",
      enabled: false,
      origin: "manual",
    });
    render(
      <GlossaryTab guide={guide} onGuideChange={vi.fn()} usage={makeUsage()} />,
    );

    fireEvent.change(screen.getByLabelText("정렬"), {
      target: { value: "stored" },
    });
    expect(glossarySourceOrder()).toEqual(["Alpha", "Beta", "Gamma"]);

    fireEvent.change(screen.getByLabelText("이름·번역·별칭 검색"), {
      target: { value: "감마" },
    });
    expect(glossarySourceOrder()).toEqual(["Gamma"]);
    fireEvent.change(screen.getByLabelText("이름·번역·별칭 검색"), {
      target: { value: "" },
    });

    fireEvent.change(screen.getByLabelText("필터"), {
      target: { value: "unused" },
    });
    expect(glossarySourceOrder()).toEqual(["Gamma"]);
    fireEvent.change(screen.getByLabelText("필터"), {
      target: { value: "low-use" },
    });
    expect(glossarySourceOrder()).toEqual(["Alpha", "Gamma"]);
    fireEvent.change(screen.getByLabelText("필터"), {
      target: { value: "disabled" },
    });
    expect(glossarySourceOrder()).toEqual(["Gamma"]);
  });

  it("does not expose usage-based cleanup when statistics failed", () => {
    render(
      <GlossaryTab
        guide={makeGuide()}
        onGuideChange={vi.fn()}
        usage={[]}
        usageAvailable={false}
      />,
    );

    expect(
      screen.getAllByText("사용 통계를 불러오지 못했습니다.").length,
    ).toBeGreaterThan(0);
    const filter = screen.getByLabelText("필터") as HTMLSelectElement;
    expect(
      [...filter.options].find((option) => option.value === "unused")?.disabled,
    ).toBe(true);
  });

  it("keeps selected entries when bulk deletion is cancelled", () => {
    const onGuideChange = vi.fn();
    render(
      <GlossaryTab
        guide={makeGuide()}
        onGuideChange={onGuideChange}
        usage={makeUsage()}
      />,
    );
    fireEvent.click(screen.getByLabelText("Alpha 선택"));
    vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "1개 삭제" }));

    expect(onGuideChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Alpha 선택")).toHaveProperty("checked", true);
  });
});

function glossarySourceOrder(): string[] {
  return screen
    .getAllByPlaceholderText("원문")
    .map((input) => (input as HTMLInputElement).value);
}

function makeGuide(): WorkStyleGuide {
  return {
    schemaVersion: 1,
    workId: "work-1",
    glossary: [
      {
        id: "alpha",
        source: "Alpha",
        target: "Alpha",
        category: "term",
        aliases: [],
        enabled: true,
        origin: "manual",
        createdAt: TS,
        updatedAt: TS,
      },
      {
        id: "beta",
        source: "Beta",
        target: "Beta",
        category: "term",
        aliases: [],
        enabled: true,
        origin: "ai",
        createdAt: TS,
        updatedAt: TS,
      },
    ],
    characters: [
      {
        id: "minho",
        displayName: "민호",
        sourceNames: ["ミンホ"],
        targetName: "민호",
        aliases: [],
        speechStyle: "neutral",
        enabled: true,
        origin: "manual",
        createdAt: TS,
        updatedAt: TS,
      },
      {
        id: "yuna",
        displayName: "유나",
        sourceNames: ["ユナ"],
        targetName: "유나",
        aliases: [],
        speechStyle: "casual",
        enabled: true,
        origin: "ai",
        createdAt: TS,
        updatedAt: TS,
      },
    ],
    rules: {
      honorifics: "preserve",
      sfxMode: "translate",
      defaultTone: "natural_korean",
    },
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeUsage(): WorkContextUsageMetric[] {
  return [
    { id: "alpha", pageCount: 1, mentionCount: 2 },
    {
      id: "beta",
      pageCount: 5,
      mentionCount: 7,
      lastSeen: {
        chapterId: "chapter-1",
        chapterTitle: "1화",
        chapterIndex: 0,
        pageId: "page-5",
        pageName: "005.png",
        pageIndex: 4,
      },
    },
  ];
}

function makeCharacterUsage(): WorkContextUsageMetric[] {
  return [
    { id: "minho", pageCount: 1, mentionCount: 1 },
    { id: "yuna", pageCount: 3, mentionCount: 4 },
  ];
}
