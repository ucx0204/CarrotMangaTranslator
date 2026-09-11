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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

function fixture(count = 2): RedactionWorkspace {
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
function show(count = 2) {
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
async function decodeCurrent(number: number) {
  const image = await screen.findByAltText(`${number}.png`);
  fireEvent.load(image);
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "이 페이지 확인",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
}

// Small DOM smoke checks only. Pixel/layout matrices and exhaustive interaction
// scenarios are intentionally absent; core state/storage/approval tests are separate.
it("opens the editor and moves to the next page", async () => {
  show();
  await screen.findByAltText("1.png");
  expect(screen.getByRole("button", { name: "선택 1장 확인" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "다음" }));
  await screen.findByAltText("2.png");
  expect(confirm).not.toHaveBeenCalled();
});

it("marks the current page reviewed without starting the task", async () => {
  show();
  await decodeCurrent(1);
  fireEvent.click(screen.getByRole("button", { name: "이 페이지 확인" }));
  expect(screen.getByAltText("1.png")).toBeTruthy();
  expect(screen.getByText("검토 1/2 · 남음 1")).toBeTruthy();
  expect(confirm).not.toHaveBeenCalled();
});

it("reviews a selection without an extra checkbox and resumes only explicitly", async () => {
  show();
  fireEvent.click(screen.getByRole("button", { name: "전체 선택" }));
  fireEvent.click(screen.getByRole("button", { name: "선택 2장 확인" }));
  const dialog = screen.getByRole("dialog", { name: "선택한 페이지 확인" });
  expect(within(dialog).queryByRole("checkbox")).toBeNull();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "선택 2장 확인" }),
  );
  expect(screen.getByText("검토 2/2 · 남음 0")).toBeTruthy();
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "작업 재개" }));
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
});
