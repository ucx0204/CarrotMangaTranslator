// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { StyleGuideResearchReview } from "../src/renderer/src/components/styleGuide/StyleGuideResearchReview";
import { StyleGuideAnalysisActions } from "../src/renderer/src/components/styleGuide/StyleGuideChrome";
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
});

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
