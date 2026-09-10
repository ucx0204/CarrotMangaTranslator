// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { ManualRedactionWorkspace } from "../src/renderer/src/components/imageRedaction/ManualRedactionWorkspace";
import {
  DEFAULT_REDACTION_PREFERENCES,
  DEFAULT_REDACTION_VIEW,
  type RedactionWorkspace,
} from "../src/shared/imageRedactionWorkspace";

const originalGetContext = HTMLCanvasElement.prototype.getContext;

const save = vi.fn(
  async (request: { expectedRevision: number }) => request.expectedRevision + 1,
);
const confirm = vi.fn(async () => true);
const cancel = vi.fn(async () => true);
const preview = vi.fn(
  async () =>
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='160'/>",
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "mangaApi",
    createTestMangaGatewayStub({
      saveRedactionWorkspace: save,
      confirmImageRedaction: confirm,
      cancelJob: cancel,
      getRedactionWorkspacePreview: preview,
      closeRedactionWorkspace: vi.fn(async () => true),
    }),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  // Only the browser canvas API is substituted. The mask rasterizer and React components run unchanged.
  const context = {
    createImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    }),
    putImageData: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
  };
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: () => context,
  });
});
afterEach(() => {
  cleanup();
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: originalGetContext,
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(count = 5): RedactionWorkspace {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    revision: 0,
    pages: Array.from({ length: count }, (_, i) => ({
      id: `p${i}`,
      name: `${i + 1}.png`,
      imagePath: `${i}.png`,
      fingerprint: "a".repeat(64),
      width: 120,
      height: 160,
      strokes: [],
      decision: "unreviewed",
    })),
    view: {
      ...DEFAULT_REDACTION_VIEW,
      mode: "grid",
      currentId: "p0",
      selectedIds: ["p0"],
    },
    preferences: { ...DEFAULT_REDACTION_PREFERENCES },
    presets: [],
  };
}
function show(count = 5) {
  const workspace = fixture(count);
  const onClose = vi.fn();
  render(
    <React.StrictMode>
      <ManualRedactionWorkspace
        workspace={workspace}
        job={{
          jobId: "22222222-2222-4222-8222-222222222222",
          sessionId: workspace.sessionId,
        }}
        onClose={onClose}
      />
    </React.StrictMode>,
  );
  return { workspace, onClose };
}
function page(number: number) {
  return screen.getByRole("option", {
    name: new RegExp(`^${number} · ${number}\\.png`),
  });
}
function pageNumber() {
  return Number(
    (
      screen.getByRole("spinbutton", {
        name: "페이지 번호로 이동",
      }) as HTMLInputElement
    ).value,
  );
}
function selectionMenu(count: number) {
  fireEvent.click(screen.getByRole("button", { name: `${count}장 선택` }));
}
async function decodeCurrent(number: number) {
  const image = await screen.findByAltText(`${number}.png`);
  fireEvent.load(image);
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "확인하고 다음",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
}

describe("single-screen manual redaction", () => {
  it("opens old grid drafts as one editor with advanced actions hidden", async () => {
    show(100);
    await screen.findByAltText("1.png");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("button", { name: "가림 프리셋" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "선택한 페이지 확인" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("option").length).toBeLessThan(12);
    expect(
      screen.getByRole("group", { name: "수동 가리기 편집 영역" }),
    ).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
  });
  it("supports click, Ctrl/Command and Shift selection in the same filmstrip", () => {
    show();
    fireEvent.click(page(2));
    expect(pageNumber()).toBe(2);
    expect(page(1).getAttribute("aria-selected")).toBe("false");
    fireEvent.click(page(3), { ctrlKey: true });
    expect(pageNumber()).toBe(3);
    expect(page(2).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(page(1), { shiftKey: true });
    expect(screen.getByRole("button", { name: "3장 선택" })).toBeTruthy();
    fireEvent.click(page(2), { metaKey: true });
    expect(screen.getByRole("button", { name: "2장 선택" })).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
  });
  it("extends selection with the arrow keys and keeps text-input keys local", () => {
    show();
    const list = screen.getByRole("listbox", { name: "가리기 페이지 목록" });
    fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    expect(pageNumber()).toBe(2);
    expect(screen.getByRole("button", { name: "2장 선택" })).toBeTruthy();
    const input = screen.getByRole("spinbutton", {
      name: "페이지 번호로 이동",
    });
    fireEvent.keyDown(input, { key: "x" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(pageNumber()).toBe(2);
  });
  it("reviews a 100-page selection and undoes the batch from its menu", async () => {
    show(100);
    const list = screen.getByRole("listbox", { name: "가리기 페이지 목록" });
    fireEvent.keyDown(list, { key: "a", ctrlKey: true });
    // The essential review action is available without opening a menu.
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "선택한 페이지 확인" }),
    );
    const dialog = screen.getByRole("dialog", { name: "선택한 페이지 확인" });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "100장에 적용" }),
    );
    expect(
      screen.getByRole("button", { name: "100 / 100장 확인" }),
    ).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
    selectionMenu(100);
    fireEvent.click(screen.getByRole("menuitem", { name: "일괄 작업 취소" }));
    expect(screen.getByRole("button", { name: "0 / 100장 확인" })).toBeTruthy();
    selectionMenu(100);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "일괄 작업 다시 실행" }),
    );
    expect(
      screen.getByRole("button", { name: "100 / 100장 확인" }),
    ).toBeTruthy();
  });
  it("never sends from repeated Enter, IME or the last page confirmation", async () => {
    show(2);
    await decodeCurrent(1);
    let canvas = screen.getByRole("group", { name: "수동 가리기 편집 영역" });
    fireEvent.keyDown(canvas, { key: "Enter", repeat: true });
    fireEvent.keyDown(canvas, { key: "Enter", isComposing: true });
    expect(pageNumber()).toBe(1);
    fireEvent.keyDown(canvas, { key: "Enter" });
    expect(pageNumber()).toBe(2);
    await decodeCurrent(2);
    canvas = screen.getByRole("group", { name: "수동 가리기 편집 영역" });
    fireEvent.keyDown(canvas, { key: "Enter" });
    fireEvent.keyDown(canvas, { key: "Enter", repeat: true });
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "확인 후 계속" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(cancel).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalled();
  });
  it("keeps the chosen brush through navigation and offers settings only on request", () => {
    show();
    const brush = screen.getByRole("button", { name: "브러시 B" });
    fireEvent.click(brush);
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    expect(
      screen
        .getByRole("button", { name: "브러시 B" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const trigger = screen.getByRole("button", { name: "설정" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "가림 프리셋" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(
      screen.queryByRole("dialog", { name: "가리기 편집 종료" }),
    ).toBeNull();
  });
});
