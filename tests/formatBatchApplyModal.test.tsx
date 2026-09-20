// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FormatBatchApplyModal } from "../src/renderer/src/components/FormatBatchApplyModal";

afterEach(cleanup);

it("keeps chapter scope selected but blocks apply when ownership changes, then permits retry", () => {
  const onApply = vi.fn();
  const onClose = vi.fn();
  const props = { selectedBlockCount: 2, onApply, onClose };
  const { rerender } = render(
    <FormatBatchApplyModal {...props} disableChapterApply={false} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "이 화 전체" }));
  rerender(<FormatBatchApplyModal {...props} disableChapterApply />);
  expect(
    screen
      .getByRole("button", { name: "이 화 전체" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  const apply = screen.getByRole("button", { name: "적용" });
  expect(apply).toHaveProperty("disabled", true);
  fireEvent.click(apply);
  expect(onApply).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  rerender(<FormatBatchApplyModal {...props} disableChapterApply={false} />);
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  expect(onApply).toHaveBeenCalledWith("chapter", expect.any(Array));
  expect(onClose).toHaveBeenCalledOnce();
});

it("still permits current-page formatting while another page is locked", () => {
  const onApply = vi.fn();
  render(
    <FormatBatchApplyModal
      selectedBlockCount={1}
      disableChapterApply
      onApply={onApply}
      onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  expect(onApply).toHaveBeenCalledWith("page", expect.any(Array));
});
