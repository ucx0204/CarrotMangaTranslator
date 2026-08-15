/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import { PageList } from "../src/renderer/src/components/PageList";

afterEach(cleanup);

describe("page list workflow status", () => {
  it("distinguishes translation completion from full postprocess completion", () => {
    render(
      <PageList
        collapsed={false}
        otherPanelCollapsed={false}
        pages={PAGES}
        selectedPageId={null}
        jobActive={false}
        onSelect={vi.fn()}
        onRetranslate={vi.fn()}
        onRemove={vi.fn()}
        onReorder={vi.fn()}
        onToggleOtherPanel={vi.fn()}
      />,
    );

    expect(screen.getByText("번역 완료")).not.toBeNull();
    expect(screen.queryByText("검토 필요")).toBeNull();
    expect(screen.getAllByText("완료").length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("tab", { name: /진행2/ }));
    expect(screen.getByText("translated.jpg")).not.toBeNull();
    expect(screen.getByText("running.jpg")).not.toBeNull();
    expect(screen.queryByText("done.jpg")).toBeNull();
    expect(screen.queryByText("failed.jpg")).toBeNull();
  });
});

function makePage(
  id: string,
  analysisStatus: MangaPage["analysisStatus"],
  translationCompletion?: MangaPage["translationCompletion"],
): MangaPage {
  return {
    id,
    name: `${id}.jpg`,
    imagePath: `${id}.jpg`,
    dataUrl:
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
    width: 1,
    height: 1,
    blocks: [],
    analysisStatus,
    ...(translationCompletion ? { translationCompletion } : {}),
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

const PAGES: MangaPage[] = [
  makePage("done", "completed"),
  makePage("translated", "completed", {
    workflow: "erase-original",
    status: "pending",
  }),
  makePage("postprocessed", "completed", {
    workflow: "erase-original",
    status: "completed",
  }),
  makePage("running", "running"),
  makePage("failed", "failed"),
  makePage("waiting", "idle"),
];
