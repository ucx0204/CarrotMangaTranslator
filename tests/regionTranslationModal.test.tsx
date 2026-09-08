// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  renderHook,
  act,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translationJobIpcContracts } from "../src/shared/ipcJobContracts";
import { RegionTranslationModal } from "../src/renderer/src/components/RegionTranslationModal";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { RegionTranslationDialog } from "../src/renderer/src/lib/regionTranslationOptions";
import { useRegionReviewForm } from "../src/renderer/src/components/useRegionReviewForm";
import { useReviewDrawing } from "../src/renderer/src/components/useRegionReviewDrawing";
import type { RegionReviewTool } from "../src/renderer/src/components/useRegionReviewDrawing";
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
    codexImageAvailable: delegated,
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

it("keeps exclusions owned by each region through switching, moving, and undo", () => {
  const input = reviewProps();
  if (!input.review) throw Error("Missing review");
  input.review.regions.push({ ...input.review.regions[0], id: "s" });
  const { result } = renderHook(() => useRegionReviewForm(input));
  const stroke = {
    space: "page" as const,
    mode: "hide" as const,
    shape: "circle" as const,
    radiusX: 20,
    radiusY: 20,
    softness: 0,
    points: [{ x: 300, y: 300 }],
  };
  act(() => result.current.addStroke(stroke));
  act(() => result.current.setFocused("s"));
  expect(result.current.strokes).toEqual([]);
  act(() => result.current.addStroke({ ...stroke, mode: "restore" }));
  expect(result.current.values[0].exclusionStrokes).toEqual([stroke]);
  expect(result.current.values[1].exclusionStrokes?.[0].mode).toBe("restore");
  act(() => result.current.setFocused("r"));
  act(() =>
    result.current.update("r", {
      sourceBbox: { x: 300, y: 200, w: 300, h: 300 },
    }),
  );
  expect(result.current.strokes[0].points[0]).toEqual({ x: 400, y: 300 });
  act(() => result.current.undo());
  expect(result.current.strokes).toEqual([stroke]);
  expect(result.current.values[1].exclusionStrokes?.[0].mode).toBe("restore");
});

it("cycles overlapping boxes on clicks without changing selection during drags or handle resizing", async () => {
  const input = reviewProps();
  if (!input.review) throw Error("Missing review");
  const original = input.review.regions[0];
  input.review.regions = ["r", "s", "t"].map((id) => ({ ...original, id }));
  const view = render(<RegionTranslationModal {...input} />);
  const first = await screen.findByRole("button", { name: "번역문 1" });
  const stage = view.container.querySelector<HTMLDivElement>(
    "[data-region-review-stage]",
  );
  if (!stage) throw Error("Missing stage");
  stage.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 1000,
    width: 1000,
    height: 1000,
    toJSON: () => ({}),
  });
  const pointer = (target: HTMLElement, type: string, x: number, y: number) => {
    target.setPointerCapture = vi.fn();
    target.releasePointerCapture = vi.fn();
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
      button: 0,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(target, event);
  };
  for (const [from, to] of [
    [1, 3],
    [3, 2],
    [2, 1],
  ]) {
    const target = screen.getByRole("button", { name: `번역문 ${from}` });
    pointer(target, "pointerdown", 350, 350);
    pointer(target, "pointerup", 350, 350);
    fireEvent.click(target, { detail: 1 });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: `번역문 ${to}` })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  }
  pointer(first, "pointerdown", 350, 350);
  pointer(first, "pointermove", 400, 350);
  pointer(first, "pointerup", 400, 350);
  expect(first.getAttribute("aria-pressed")).toBe("true");
  expect(first.parentElement?.style.left).toBe("25%");
  const handle = screen.getByRole("button", { name: "오른쪽 아래 크기 조절" });
  pointer(handle, "pointerdown", 550, 500);
  pointer(handle, "pointermove", 570, 520);
  pointer(handle, "pointerup", 570, 520);
  expect(first.getAttribute("aria-pressed")).toBe("true");
  expect(first.parentElement?.style.width).toBe("32%");
});

it("paints the selected region without losing text, transforms its shape, and undoes region/group edits", () => {
  const input = reviewProps();
  const { result } = renderHook(() => useRegionReviewForm(input));
  const original = result.current.values[0];
  const stroke = {
    space: "page" as const,
    mode: "hide" as const,
    shape: "circle" as const,
    radiusX: 10,
    radiusY: 20,
    softness: 0,
    points: [
      { x: 200, y: 300 },
      { x: 500, y: 600 },
    ],
  };
  act(() => result.current.addPaintStroke(stroke));
  expect(result.current.values).toHaveLength(1);
  expect(result.current.values[0]).toMatchObject({
    regionId: original.regionId,
    text: original.text,
    sourceBbox: { x: 190, y: 280, w: 320, h: 340 },
    selectionStrokes: [stroke],
  });
  act(() =>
    result.current.update("r", {
      sourceBbox: { x: 290, y: 380, w: 320, h: 340 },
    }),
  );
  expect(result.current.values[0].selectionStrokes?.[0].points[0]).toEqual({
    x: 300,
    y: 400,
  });
  act(() => result.current.undo());
  expect(result.current.values[0].selectionStrokes).toEqual([stroke]);
  act(() => result.current.undo());
  expect(result.current.values[0].sourceBbox).toEqual(original.sourceBbox);
  expect(result.current.values[0].selectionStrokes).toBeUndefined();
  act(() => result.current.redo());
  act(() => result.current.addRegion({ x: 700, y: 600, w: 100, h: 200 }));
  const added = result.current.focused;
  if (!added) throw new Error("Missing added region");
  act(() =>
    result.current.update(added, { text: "new text", styleGroupId: "r" }),
  );
  expect(result.current.values[1]).toMatchObject({
    text: "new text",
    styleGroupId: "r",
  });
  act(() => result.current.removeRegion());
  expect(result.current.values).toHaveLength(1);
  act(() => result.current.undo());
  expect(result.current.values[1]).toMatchObject({
    text: "new text",
    styleGroupId: "r",
  });
});

function reviewProps(): RegionTranslationDialog {
  return {
    ...props(true),
    onConfirm: vi.fn(),
    review: {
      sessionId: "11111111-1111-4111-8111-111111111111",
      regions: [
        {
          id: "r",
          sourceText: "source",
          translatedText: "translation",
          sourceBbox: { x: 200, y: 200, w: 300, h: 300 },
        },
      ],
    },
  };
}

it("shares eight handles and supports undo/redo while leaving native text shortcuts alone", async () => {
  const input = reviewProps();
  const view = render(<RegionTranslationModal {...input} />);
  const box = await screen.findByRole("button", { name: "번역문 1" });
  expect(view.container.querySelectorAll("[data-resize-handle]")).toHaveLength(
    8,
  );
  const frame = box.parentElement;
  if (!frame) throw Error("Missing region frame");
  fireEvent.keyDown(box, { key: "ArrowRight", shiftKey: true });
  fireEvent.keyDown(box, { key: "ArrowRight", shiftKey: true, repeat: true });
  fireEvent.keyUp(box, { key: "ArrowRight" });
  expect(frame.style.left).toBe("22%");
  fireEvent.keyDown(box, { key: "z", ctrlKey: true });
  expect(frame.style.left).toBe("20%");
  fireEvent.keyDown(box, { key: "Z", ctrlKey: true, shiftKey: true });
  expect(frame.style.left).toBe("22%");
  const text = screen.getByRole("textbox", { name: "번역문 1" });
  fireEvent.change(text, { target: { value: "revised" } });
  expect(fireEvent.keyDown(text, { key: "z", ctrlKey: true })).toBe(true);
  expect(frame.style.left).toBe("22%");
  fireEvent.keyDown(box, { key: "z", ctrlKey: true });
  fireEvent.keyDown(box, { key: "y", ctrlKey: true });
  expect(frame.style.left).toBe("22%");
  expect((text as HTMLInputElement).value).toBe("revised");
  fireEvent.keyDown(box, { key: "b" });
  expect(
    view.container
      .querySelector("[data-region-review-stage]")
      ?.getAttribute("data-tool"),
  ).toBe("hide");
});

it("edits style groups and numeric bounds, and restores canvas tools after temporary panning", async () => {
  const input = reviewProps();
  if (!input.review) throw Error("Missing review");
  const sourceRegion = input.review.regions[0];
  input.review.regions = ["r", "s"].map((id, index) => ({
    ...sourceRegion,
    id,
    sourceText: "",
    styleGroupId: "shared",
    sourceBbox: { x: 100 + index * 400, y: 200, w: 300, h: 300 },
  }));
  const view = render(<RegionTranslationModal {...input} />);
  const peer = await screen.findByRole("checkbox", {
    name: "2번과 스타일 맞추기",
  });
  expect((peer as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByRole("combobox", { name: "스타일 그룹" })).toBeNull();
  fireEvent.click(peer);
  expect((peer as HTMLInputElement).checked).toBe(false);
  fireEvent.click(peer);
  expect((peer as HTMLInputElement).checked).toBe(true);
  const left = screen.getByRole("spinbutton", { name: "왼쪽" });
  fireEvent.change(left, { target: { value: "50" } });
  fireEvent.blur(left);
  expect(
    screen.getByRole("button", { name: "번역문 1" }).parentElement?.style.left,
  ).toBe("15.625%");
  const viewport = view.container.querySelector<HTMLDivElement>(
    "[tabindex='0'][aria-label='선택 영역']",
  );
  const stage = view.container.querySelector("[data-region-review-stage]");
  if (!viewport || !stage) throw Error("Missing review canvas");
  fireEvent.keyDown(viewport, { key: "p" });
  expect(stage.getAttribute("data-tool")).toBe("paint");
  const size = screen.getByRole("spinbutton", { name: "크기" });
  fireEvent.keyDown(viewport, { key: "]" });
  expect((size as HTMLInputElement).value).toBe("28");
  fireEvent.keyDown(viewport, { key: "[" });
  expect((size as HTMLInputElement).value).toBe("24");
  fireEvent.keyDown(viewport, { key: " " });
  expect(stage.getAttribute("data-tool")).toBe("pan");
  fireEvent.keyUp(viewport, { key: " " });
  expect(stage.getAttribute("data-tool")).toBe("paint");
  fireEvent.keyDown(viewport, { key: " " });
  fireEvent.blur(window);
  expect(stage.getAttribute("data-tool")).toBe("paint");
  fireEvent.keyDown(viewport, { key: "h", altKey: true });
  expect(stage.getAttribute("data-tool")).toBe("paint");
  fireEvent.keyDown(viewport, { key: "Delete" });
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  fireEvent.keyDown(viewport, { key: "z", ctrlKey: true });
  expect(screen.getAllByRole("textbox")).toHaveLength(2);
});

it("keeps style choices identifiable when translations are cleared or a new region has no text", async () => {
  const input = reviewProps();
  if (!input.review) throw Error("Missing review");
  const original = input.review.regions[0];
  input.review.regions.push(
    {
      ...original,
      id: "source-only",
      sourceText: "peer source",
      translatedText: "",
    },
    { ...original, id: "blank", sourceText: "", translatedText: "" },
  );
  render(<RegionTranslationModal {...input} />);
  const peer = await screen.findByRole("checkbox", {
    name: "2번과 스타일 맞추기",
  });
  const blank = screen.getByRole("checkbox", { name: "3번과 스타일 맞추기" });
  expect(peer.closest("label")?.textContent).toContain("2 · peer source");
  expect(blank.closest("label")?.textContent).toContain("3 · 영역 추가");
  fireEvent.change(screen.getByRole("textbox", { name: "번역문 3" }), {
    target: { value: "new translation" },
  });
  expect(screen.getByText("3 · new translation")).toBeTruthy();
});

it("preserves per-region brushes after mask preparation fails and submits their scopes on retry", async () => {
  const decode = vi
    .fn()
    .mockRejectedValueOnce(Error("mask decode failed"))
    .mockResolvedValue(undefined);
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode = decode;
    },
  );
  const maskDrawing: Pick<CanvasRenderingContext2D, "drawImage"> = {
    drawImage: vi.fn(),
  };
  const context = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(maskDrawing as CanvasRenderingContext2D);
  const raster = vi
    .spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockReturnValue("data:image/png;base64,AA==");
  try {
    const input = reviewProps();
    if (!input.review) throw Error("Missing review");
    input.review.regions.push({ ...input.review.regions[0], id: "s" });
    const { result } = renderHook(() => useRegionReviewForm(input));
    const stroke = {
      space: "page" as const,
      mode: "hide" as const,
      shape: "square" as const,
      radiusX: 20,
      radiusY: 20,
      softness: 0,
      points: [{ x: 350, y: 350 }],
    };
    act(() => result.current.addStroke(stroke, "r"));
    act(() => result.current.addPaintStroke(stroke, "s"));
    await act(() => result.current.confirm());
    expect(input.onConfirm).not.toHaveBeenCalled();
    expect(result.current.error).toBe("mask decode failed");
    expect(result.current.values[0].exclusionStrokes).toEqual([stroke]);
    await act(() => result.current.confirm());
    expect(result.current.error).toBe("");
    expect(input.onConfirm).toHaveBeenCalledWith(expect.any(Array), {
      strokes: [],
      maskDataUrl: "data:image/png;base64,AA==",
      regions: ["r", "s"].map((regionId) => ({
        regionId,
        maskDataUrl: "data:image/png;base64,AA==",
      })),
    });
    expect(result.current.values[1].selectionStrokes).toEqual([stroke]);
  } finally {
    context.mockRestore();
    raster.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("groups a whole drag and each brush stroke in one shared history and cancels incomplete gestures", () => {
  const input = reviewProps();
  const { result } = renderHook(() => useRegionReviewForm(input));
  const initial = result.current.values[0].sourceBbox;
  act(() => result.current.update("r", { sourceBbox: { ...initial } }));
  expect(result.current.canUndo).toBe(false);
  const stroke = {
    space: "page" as const,
    mode: "hide" as const,
    shape: "circle" as const,
    radiusX: 20,
    radiusY: 30,
    softness: 0,
    points: [{ x: 500, y: 500 }],
  };
  act(() => {
    result.current.beginGesture();
    result.current.update("r", { sourceBbox: { ...initial, x: 250 } });
    result.current.update("r", { sourceBbox: { ...initial, x: 280 } });
    result.current.endGesture();
  });
  act(() => result.current.addStroke(stroke));
  act(() => result.current.undo());
  expect(result.current.strokes).toEqual([]);
  expect(result.current.values[0].sourceBbox.x).toBe(280);
  act(() => result.current.undo());
  expect(result.current.values[0].sourceBbox).toEqual(initial);
  act(() => result.current.redo());
  act(() => result.current.redo());
  expect(result.current.strokes).toEqual([stroke]);
  act(() => {
    result.current.beginGesture();
    result.current.update("r", { sourceBbox: { ...initial, x: 350 } });
    result.current.cancelGesture();
  });
  expect(result.current.values[0].sourceBbox.x).toBe(280);
  act(() => result.current.undo());
  act(() => result.current.addStroke({ ...stroke, mode: "restore" }));
  expect(result.current.canRedo).toBe(false);
});

it("records crop-normalized brush geometry, cancels interrupted strokes, and pans without painting", () => {
  const input = reviewProps();
  const stage = document.createElement("div");
  stage.getBoundingClientRect = () => ({
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    width: 320,
    height: 360,
    right: 330,
    bottom: 380,
    toJSON: () => ({}),
  });
  stage.setPointerCapture = vi.fn();
  stage.releasePointerCapture = vi.fn();
  const viewport = document.createElement("div");
  viewport.scrollLeft = 80;
  viewport.scrollTop = 90;
  const ref = { current: stage },
    viewportRef = { current: viewport };
  const { result, rerender } = renderHook(
    ({ tool }: { tool: RegionReviewTool }) => {
      const form = useRegionReviewForm(input);
      const drawing = useReviewDrawing(
        {
          form,
          crop: { w: 320, h: 360 },
          tool,
          shape: "square",
          size: 32,
        },
        ref,
        viewportRef,
      );
      return { form, drawing };
    },
    { initialProps: { tool: "hide" } },
  );
  const pointer = (x: number, y: number, button = 0) =>
    ({
      clientX: x,
      clientY: y,
      button,
      pointerId: 1,
      currentTarget: stage,
      preventDefault: () => {},
    }) as React.PointerEvent<HTMLDivElement>;
  act(() => result.current.drawing.handlers.onPointerDown?.(pointer(90, 110)));
  act(() => result.current.drawing.handlers.onPointerMove?.(pointer(170, 200)));
  act(() => result.current.drawing.handlers.onPointerUp?.(pointer(170, 200)));
  expect(result.current.form.strokes[0]).toMatchObject({
    mode: "hide",
    shape: "square",
    radiusX: 50,
    points: [
      { x: 250, y: 250 },
      { x: 500, y: 500 },
      { x: 500, y: 500 },
    ],
  });
  act(() => result.current.drawing.handlers.onPointerDown?.(pointer(90, 110)));
  act(() =>
    result.current.drawing.handlers.onPointerCancel?.(pointer(100, 120)),
  );
  expect(result.current.drawing.draft).toBeNull();
  expect(result.current.form.strokes).toHaveLength(1);
  act(() =>
    result.current.drawing.handlers.onPointerDown?.(pointer(100, 120, 1)),
  );
  act(() =>
    result.current.drawing.handlers.onPointerMove?.(pointer(130, 140, 1)),
  );
  act(() =>
    result.current.drawing.handlers.onPointerUp?.(pointer(130, 140, 1)),
  );
  expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([50, 70]);
  expect(result.current.form.strokes).toHaveLength(1);
  rerender({ tool: "paint" });
  act(() => result.current.drawing.handlers.onPointerDown?.(pointer(90, 110)));
  // A shortcut pressed during a stroke must not change that stroke's meaning.
  rerender({ tool: "hide" });
  act(() => result.current.drawing.handlers.onPointerUp?.(pointer(170, 200)));
  expect(result.current.form.strokes).toHaveLength(1);
  expect(result.current.form.values[0].selectionStrokes).toHaveLength(1);
  act(() => result.current.drawing.handlers.onPointerDown?.(pointer(90, 110)));
  act(() =>
    result.current.drawing.handlers.onLostPointerCapture?.(pointer(90, 110)),
  );
  expect(result.current.drawing.draft).toBeNull();
  expect(result.current.form.strokes).toHaveLength(1);
  rerender({ tool: "restore" });
  act(() => result.current.drawing.handlers.onPointerDown?.(pointer(90, 110)));
  act(() => result.current.drawing.handlers.onPointerUp?.(pointer(90, 110)));
  expect(result.current.form.strokes.at(-1)?.mode).toBe("restore");
});
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
      .getByRole("button", { name: "번역문 3" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.keyDown(
    screen.getByRole("button", { name: "오른쪽 아래 크기 조절" }),
    { key: "ArrowRight", shiftKey: true },
  );
  fireEvent.click(screen.getByRole("button", { name: "생성" }));
  await waitFor(() =>
    expect(input.onConfirm).toHaveBeenCalledWith(
      input.review.regions.map((region, index) => ({
        regionId: region.id,
        text: "고",
        sourceBbox: { ...region.sourceBbox, w: index === 2 ? 210 : 200 },
        sourceText: region.sourceText,
        styleGroupId: region.id,
        parentRegionId: undefined,
      })),
      undefined,
    ),
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

it("blocks generation if the displayed image cannot be decoded", async () => {
  const input = props();
  const view = render(<RegionTranslationModal {...input} />);
  await waitFor(() =>
    expect(view.container.querySelector("image")).not.toBeNull(),
  );
  const image = view.container.querySelector("image");
  if (!image) throw Error("Missing preview image");
  fireEvent.error(image);
  expect(screen.getByRole("alert").textContent).toContain("불러오지");
  expect(
    (screen.getByRole("button", { name: "실행" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(input.onClose).toHaveBeenCalledOnce();
  expect(input.onRun).not.toHaveBeenCalled();
});
