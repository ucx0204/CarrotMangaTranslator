// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translationJobIpcContracts } from "../src/shared/ipcJobContracts";
import { RegionTranslationModal } from "../src/renderer/src/components/RegionTranslationModal";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { RegionTranslationDialog } from "../src/renderer/src/lib/regionTranslationOptions";
const page = {
  id: "p",
  imagePath: "original.png",
  dataUrl: "",
  name: "p.png",
  width: 800,
  height: 1200,
  blocks: [],
  analysisStatus: "idle" as const,
  createdAt: "",
  updatedAt: "",
};
function props(delegated = false): RegionTranslationDialog {
  return {
    page,
    bbox: { x: 100, y: 200, w: 400, h: 300 },
    codexDelegateAll: delegated,
    initial: { output: "text", eraseOriginal: false },
    onRun: vi.fn(),
    onClose: vi.fn(),
  };
}
beforeEach(() => {
  window.mangaApi = createTestMangaGatewayStub({
    getPageImageDataUrl: vi.fn(
      async () => "data:image/png;base64,cHJldmlldw==",
    ),
  });
});
afterEach(cleanup);
describe("compact region translation dialog", () => {
  it("shows only the preview and erasure toggle for standard translation", async () => {
    const input = props();
    render(<RegionTranslationModal {...input} />);
    const run = await screen.findByRole("button", { name: "실행" });
    expect(
      screen.getByRole("img", { name: "선택 영역" }).getAttribute("viewBox"),
    ).toBe("80 240 320 360");
    expect(screen.queryByText("결과 형태")).toBeNull();
    expect(
      screen.queryByText(/번역 언어|다시 선택|한국어|인페인팅 엔진/),
    ).toBeNull();
    expect(screen.queryByText(/^(ON|OFF)$/)).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "원문 지우기" }));
    fireEvent.click(run);
    expect(input.onRun).toHaveBeenCalledWith({
      output: "text",
      eraseOriginal: true,
    });
  });
  it("offers editable text or generated image only in delegation mode", async () => {
    const input = props(true);
    render(<RegionTranslationModal {...input} />);
    const run = await screen.findByRole("button", { name: "실행" });
    fireEvent.click(screen.getByRole("radio", { name: "효과음 이미지" }));
    fireEvent.click(run);
    expect(input.onRun).toHaveBeenCalledWith({
      output: "image",
      eraseOriginal: false,
    });
  });
  it("accepts a saved region result with an undo transaction through IPC", () => {
    const result = {
      status: "completed",
      history: { transactionId: "11111111-1111-4111-8111-111111111111" },
      pageId: "p",
      blockIds: [],
    };
    expect(
      translationJobIpcContracts.translateRegion.result.parse(result),
    ).toEqual(result);
  });
  it("cancel never runs translation", () => {
    const input = props();
    render(<RegionTranslationModal {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(input.onClose).toHaveBeenCalledOnce();
    expect(input.onRun).not.toHaveBeenCalled();
  });
});

it("lets the user replace every generated SFX before generation and retains edits on a server error", async () => {
  const input = {
    ...props(true),
    onConfirm: vi.fn(),
    review: {
      sessionId: "11111111-1111-4111-8111-111111111111",
      regions: ["a", "b", "c"].map((id, index) => ({
        id,
        sourceText: "ゴ",
        translatedText: "고오",
        sourceBbox: { x: index * 250, y: index * 200, w: 200, h: 200 },
      })),
    },
  };
  const view = render(<RegionTranslationModal {...input} />);
  await screen.findByRole("button", { name: "생성" });
  for (let number = 1; number <= 3; number++) {
    const field = screen.getByRole("textbox", { name: `번역문 ${number}` });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "고" } });
  }
  expect(
    screen
      .getByRole("img", { name: "선택 영역" })
      .querySelector("rect")
      ?.getAttribute("x"),
  ).toBe("240");
  fireEvent.click(screen.getByRole("button", { name: "생성" }));
  expect(input.onConfirm).toHaveBeenCalledWith(
    ["a", "b", "c"].map((regionId) => ({ regionId, text: "고" })),
  );
  expect(input.onRun).not.toHaveBeenCalled();
  view.rerender(
    <RegionTranslationModal {...input} error="연결을 확인해 주세요." />,
  );
  expect((screen.getAllByRole("textbox")[0] as HTMLInputElement).value).toBe(
    "고",
  );
  expect(screen.getByRole("alert").textContent).toContain("연결");
  fireEvent.change(screen.getAllByRole("textbox")[1], {
    target: { value: " " },
  });
  expect(
    (screen.getByRole("button", { name: "생성" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("keeps cancel available while recognition locks its settings", async () => {
  const input = { ...props(true), busy: true };
  render(<RegionTranslationModal {...input} />);
  expect(
    (screen.getByRole("button", { name: "인식 중" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(input.onClose).toHaveBeenCalledOnce();
  expect(input.onRun).not.toHaveBeenCalled();
});
