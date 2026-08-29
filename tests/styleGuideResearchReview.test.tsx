// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { StyleGuideResearchProgressModal } from "../src/renderer/src/components/StyleGuideModal";
import { StyleGuideResearchReview } from "../src/renderer/src/components/styleGuide/StyleGuideResearchReview";
import { StyleGuideAnalysisActions } from "../src/renderer/src/components/styleGuide/StyleGuideChrome";
import {
  mergeStyleGuideResearchProgress,
  type StyleGuideResearchProgress,
} from "../src/renderer/src/components/styleGuide/useStyleGuideInternetResearch";
import type { JobEvent } from "../src/shared/jobTypes";
import type { WorkContextResearchProposal } from "../src/shared/workContextResearchTypes";

const openResearchSource = vi.fn(async (url: string) => ({
  opened: true,
  url,
}));

beforeEach(() => {
  openResearchSource.mockClear();
  window.mangaApi = createTestMangaGatewayStub({ openResearchSource });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "mangaApi");
});

describe("StyleGuideResearchReview", () => {
  it("lets the user opt into unchecked proposals", () => {
    render(<Harness />);

    expect(screen.getByTestId("selected-count").textContent).toBe("1");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "ラヴィ 변경안 선택" }),
    );
    expect(screen.getByTestId("selected-count").textContent).toBe("2");
  });

  it("selects and clears every proposal with explicit bulk actions", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "전체 선택" }));
    expect(screen.getByTestId("selected-count").textContent).toBe("2");
    expect(
      screen.getByRole("checkbox", { name: "開錠 변경안 선택" }),
    ).toHaveProperty("checked", true);
    expect(
      screen.getByRole("checkbox", { name: "ラヴィ 변경안 선택" }),
    ).toHaveProperty("checked", true);

    fireEvent.click(screen.getByRole("button", { name: "전체 해제" }));
    expect(screen.getByTestId("selected-count").textContent).toBe("0");
    expect(
      screen.getByRole("checkbox", { name: "開錠 변경안 선택" }),
    ).toHaveProperty("checked", false);
    expect(
      screen.getByRole("checkbox", { name: "ラヴィ 변경안 선택" }),
    ).toHaveProperty("checked", false);
  });

  it("opens only the reviewed HTTPS source through the app bridge", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Official work" }));
    expect(openResearchSource).toHaveBeenCalledWith(
      "https://example.test/official",
    );
  });

  it("shows the active research engine without an inline cancel action", () => {
    const onAnalyze = vi.fn();
    const onEngineChange = vi.fn();
    const { rerender } = render(
      <StyleGuideAnalysisActions
        analyzing
        disabled={false}
        engine="codex-web"
        onEngineChange={onEngineChange}
        onAnalyze={onAnalyze}
      />,
    );

    expect(
      screen.getByRole("radio", { name: "Codex" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByRole("button", { name: "조사 취소" })).toBeNull();

    rerender(
      <StyleGuideAnalysisActions
        analyzing={false}
        disabled={false}
        engine="tavily"
        onEngineChange={onEngineChange}
        onAnalyze={onAnalyze}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Codex" }));
    expect(onEngineChange).toHaveBeenCalledWith("codex-web");
    fireEvent.click(screen.getByRole("button", { name: "용어집 조사" }));
    expect(onAnalyze).toHaveBeenCalledWith();
  });

  it("shows a nested research progress surface with stages and cancellation", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <StyleGuideResearchProgressModal
        progress={makeProgress()}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole("dialog", { name: "용어집 조사 중" })).toBeTruthy();
    expect(screen.getByText("웹에서 근거를 수집하고 있습니다")).toBeTruthy();
    expect(screen.getByText("Tavily 크레딧")).toBeTruthy();
    expect(screen.getByText("2 / 10")).toBeTruthy();
    expect(screen.getByText("作品名 キャラクター 公式")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "조사 취소" }));
    expect(onCancel).toHaveBeenCalledOnce();

    rerender(
      <StyleGuideResearchProgressModal
        progress={{ ...makeProgress(), cancelling: true }}
        onCancel={onCancel}
      />,
    );
    expect(
      screen.getByRole("button", { name: "조사 취소 중…" }),
    ).toHaveProperty("disabled", true);
  });

  it("keeps only five curated search activities and updates a completed query", () => {
    let progress = makeProgress();
    for (let index = 1; index <= 6; index += 1) {
      progress = mergeStyleGuideResearchProgress(
        progress,
        makeResearchEvent(index, index === 6 ? 4 : undefined),
      );
    }
    progress = mergeStyleGuideResearchProgress(
      progress,
      makeResearchEvent(6, 3),
    );

    expect(progress.activities).toHaveLength(5);
    expect(progress.activities[0]?.queryIndex).toBe(2);
    expect(progress.activities.at(-1)).toMatchObject({
      queryIndex: 6,
      resultCount: 3,
    });
  });
});

function makeProgress(): StyleGuideResearchProgress {
  return {
    runId: "run-1",
    engine: "tavily",
    researchTitle: "테스트 작품",
    startedAt: Date.now(),
    stage: "searching",
    progressText: "웹 근거 수집 중",
    metrics: {
      stage: "searching",
      query: "作品名 キャラクター 公式",
      queryIndex: 2,
      resultCount: 4,
      creditsUsed: 2,
      creditLimit: 10,
    },
    activities: [
      {
        id: "2:作品名 キャラクター 公式",
        query: "作品名 キャラクター 公式",
        queryIndex: 2,
        resultCount: 4,
      },
    ],
    cancelling: false,
  };
}

function makeResearchEvent(index: number, resultCount?: number): JobEvent {
  return {
    id: "work-context-research-run-1",
    kind: "internet-research",
    status: "running",
    progressText: "웹 근거 수집 중",
    phase: "model_requesting",
    research: {
      stage: "searching",
      query: `query-${index}`,
      queryIndex: index,
      ...(resultCount === undefined ? {} : { resultCount }),
      creditsUsed: index,
      creditLimit: 10,
    },
  };
}

function Harness() {
  const [selected, setSelected] = React.useState<Set<string>>(
    new Set(["operation-high"]),
  );
  return (
    <>
      <output data-testid="selected-count">{selected.size}</output>
      <StyleGuideResearchReview
        proposal={makeProposal()}
        selectedIds={selected}
        onSelectedIdsChange={setSelected}
      />
    </>
  );
}

function makeProposal(): WorkContextResearchProposal {
  const timestamp = "2026-08-28T00:00:00.000Z";
  const entry = (id: string, source: string, target: string) => ({
    id,
    source,
    target,
    category: "term" as const,
    origin: "ai" as const,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return {
    engine: "tavily",
    baseFingerprint: "fingerprint",
    operations: [
      {
        id: "operation-high",
        entity: "glossary",
        action: "add",
        reason: "공식 표기 확인",
        confidence: "high",
        selectedByDefault: true,
        evidence: { pageCount: 1, mentionCount: 2 },
        sources: [
          { title: "Official work", url: "https://example.test/official" },
        ],
        after: entry("entry-1", "開錠", "개정"),
      },
      {
        id: "operation-medium",
        entity: "glossary",
        action: "add",
        reason: "추가 검토 필요",
        confidence: "medium",
        selectedByDefault: false,
        evidence: { pageCount: 1, mentionCount: 1 },
        sources: [],
        after: entry("entry-2", "ラヴィ", "라비"),
      },
    ],
    warnings: [],
    stats: {
      queryCount: 4,
      sourceCount: 1,
      tavilyCreditsUsed: 4,
      estimatedTokenDelta: 30,
      elapsedMs: 1_500,
    },
  };
}
