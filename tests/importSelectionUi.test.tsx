/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportPreviewResult } from "../src/shared/importTypes";
import type { LibraryIndex } from "../src/shared/libraryTypes";
import { ImportModal } from "../src/renderer/src/components/ImportModal";

afterEach(cleanup);

describe("ImportModal selection surfaces", () => {
  it("keeps target cards and editable chapter rows visually selected", () => {
    render(
      <ImportModal
        library={LIBRARY}
        preview={PREVIEW}
        busy={false}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    const newTarget = screen.getByRole("radio", { name: "새 작품 만들기" });
    expect(
      (newTarget.closest(".selection-surface") as HTMLElement | null)?.dataset
        .selected,
    ).toBe("true");

    const titleInput = screen.getByDisplayValue("2화");
    const chapterToggle = screen.getByRole("checkbox", {
      name: "2화 · 1페이지",
    });
    const chapterRow = titleInput.closest(
      ".selection-field-row",
    ) as HTMLElement | null;
    expect(chapterRow?.dataset.selected).toBe("true");

    fireEvent.click(titleInput);
    expect((chapterToggle as HTMLInputElement).checked).toBe(true);

    fireEvent.click(chapterToggle);
    expect((chapterToggle as HTMLInputElement).checked).toBe(false);
    expect(chapterRow?.dataset.selected).toBe("false");
    expect((titleInput as HTMLInputElement).disabled).toBe(true);
  });

  it("defaults to adding a chapter to the currently open work", () => {
    render(
      <ImportModal
        library={LIBRARY}
        currentWorkId="work-1"
        preview={PREVIEW}
        busy={false}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(
      (
        screen.getByRole("radio", {
          name: /현재 작품에 새 화 추가/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        screen.getByRole("radio", {
          name: "새 작품 만들기",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(screen.getByText(/새 화로 추가됩니다/)).not.toBeNull();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(
      "work-1",
    );
  });
});

const LIBRARY: LibraryIndex = {
  workOrder: ["work-1"],
  works: [
    {
      id: "work-1",
      title: "기존 작품",
      chapterOrder: [],
      chapters: [],
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    },
  ],
};

const PREVIEW: ImportPreviewResult = {
  mode: "batch",
  sourceKind: "images",
  suggestedWorkTitle: "새 작품",
  chapters: [
    {
      draftId: "draft-1",
      title: "1화",
      sourceKind: "images",
      pages: [{ name: "1.png", sourcePath: "1.png", sourceKind: "file" }],
    },
    {
      draftId: "draft-2",
      title: "2화",
      sourceKind: "images",
      pages: [{ name: "2.png", sourcePath: "2.png", sourceKind: "file" }],
    },
  ],
};
