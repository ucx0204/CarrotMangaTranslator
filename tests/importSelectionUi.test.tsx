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
    expect(
      (
        screen.getByRole("combobox", {
          name: "작품 선택",
        }) as HTMLButtonElement
      ).value,
    ).toBe("work-1");
  });

  it("defaults every import to source-format result auto-save", () => {
    const onSubmit = vi.fn();
    render(
      <ImportModal
        library={LIBRARY}
        preview={PREVIEW}
        busy={false}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(
      screen
        .getByRole("switch", { name: "결과물 폴더에 자동 저장" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("combobox", { name: "자동 저장 형식" }),
    ).toHaveProperty("value", "source");

    fireEvent.click(screen.getByRole("button", { name: "추가 후 번역" }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        linkedWorkspace: {
          enabled: true,
          outputFormat: "source",
          jpegQuality: 95,
          webpQuality: 90,
        },
      }),
    );
  });

  it("identifies images excluded by the import preflight", () => {
    render(
      <ImportModal
        library={LIBRARY}
        preview={{
          ...PREVIEW,
          excludedPages: [
            {
              chapterTitle: "1화",
              pageName: "002.png",
              reason: "invalid-image-header",
            },
          ],
        }}
        busy={false}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(
      screen.getByText("가져오기 전 검사에서 이미지 1개를 제외했습니다"),
    ).not.toBeNull();
    expect(screen.getByText(/1화 \/ 002\.png/)).not.toBeNull();
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
