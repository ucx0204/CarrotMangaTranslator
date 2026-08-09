/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatherTextFooter } from "../src/renderer/src/components/gatherText/GatherTextFooter";

afterEach(cleanup);

describe("gather text footer", () => {
  it("keeps copy primary and groups secondary file exchange actions", () => {
    const onExportReview = vi.fn();
    render(
      <GatherTextFooter
        excludeHeaders={false}
        onToggleExcludeHeaders={vi.fn()}
        hasContent
        hasChapter
        canImportTxt
        reviewBusy={false}
        onSave={vi.fn()}
        onCopy={vi.fn()}
        onExportReview={onExportReview}
        onImportReview={vi.fn()}
        onImportTxt={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "복사" })).not.toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "가져오기 · 내보내기" }),
    );
    expect(
      screen.getByRole("menu", { name: "가져오기 · 내보내기" }),
    ).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: ".txt 저장" })).not.toBeNull();
    expect(
      screen.getByRole("menuitem", { name: ".txt 불러오기" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("menuitem", { name: "검수표 가져오기" }),
    ).not.toBeNull();

    fireEvent.click(
      screen.getByRole("menuitem", { name: "CSV 검수표 내보내기" }),
    );
    expect(onExportReview).toHaveBeenCalledWith("csv");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
