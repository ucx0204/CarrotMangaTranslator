/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranslateSourceModal } from "../src/renderer/src/components/TranslateSourceModal";

afterEach(cleanup);

describe("TranslateSourceModal", () => {
  it("keeps source choices neutral and omits the redundant ordering note", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <TranslateSourceModal
        busy={false}
        onCancel={vi.fn()}
        onSelect={onSelect}
      />,
    );

    const images = screen.getByRole("button", { name: /이미지 열기/ });
    expect(images.classList.contains("primary")).toBe(false);
    const sourceChoices = [...container.querySelectorAll(".source-choice")];
    expect(sourceChoices).toHaveLength(5);
    expect(
      sourceChoices.every((choice) => choice.className === "source-choice"),
    ).toBe(true);
    expect(container.querySelector(".source-choice-order-note")).toBeNull();
    expect(screen.queryByText(/파일명의 숫자를 인식/)).toBeNull();
    fireEvent.click(images);
    expect(onSelect).toHaveBeenCalledWith("images");
    fireEvent.click(screen.getByRole("button", { name: /PDF 열기/ }));
    expect(onSelect).toHaveBeenCalledWith("pdf");
  });
});
