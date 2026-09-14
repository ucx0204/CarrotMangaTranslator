/** @vitest-environment jsdom */
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GeneratedLetteringControls } from "../src/renderer/src/components/GeneratedLetteringControls";
import { GeneratedLetteringImage } from "../src/renderer/src/components/GeneratedLetteringImage";
import { useLetteringStroke } from "../src/renderer/src/hooks/useLetteringStroke";
import { createWorkspaceInteractionPreviewStore } from "../src/renderer/src/lib/workspaceInteractionPreview";
import {
  DEFAULT_LETTERING_TOOL,
  letteringPaintSvg,
} from "../src/shared/generatedLetteringMask";
import { generatedLettering } from "../src/shared/blockFormatValueSchemas";
import { relocateGeneratedLettering } from "../src/shared/generatedLettering";
import type { TranslationBlock } from "../src/shared/textTypes";
import type { MangaPage } from "../src/shared/libraryTypes";

afterEach(cleanup);
const block: TranslationBlock = {
  id: "lettering",
  bbox: { x: 200, y: 200, w: 400, h: 400 },
  type: "nonsolid",
  sourceText: "ドン",
  translatedText: "쿵",
  confidence: 1,
  sourceDirection: "horizontal",
  renderDirection: "horizontal",
  fontSizePx: 24,
  lineHeight: 1.2,
  textAlign: "center",
  textColor: "#123456",
  backgroundColor: "#ffffff",
  opacity: 0,
  generatedLettering: {
    version: 1,
    dataUrl: "data:image/png;base64,aGVsbG8=",
    sourceText: "ドン",
    translatedText: "쿵",
    outline: { width: 3, color: "#ffffff" },
  },
};
const page: MangaPage = {
  id: "page",
  name: "page.png",
  imagePath: "page.png",
  dataUrl: "",
  width: 1000,
  height: 1000,
  blocks: [block],
  analysisStatus: "completed",
  createdAt: "",
  updatedAt: "",
};
function event(x: number, y: number): React.PointerEvent<SVGSVGElement> {
  const surface = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  surface.setPointerCapture = vi.fn();
  surface.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 1000);
  const input: Partial<React.PointerEvent<SVGSVGElement>> = {
    button: 0,
    pointerId: 7,
    clientX: x,
    clientY: y,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    currentTarget: surface,
  };
  return input as React.PointerEvent<SVGSVGElement>;
}

it("changes image outline independently of text formatting and gates conflicting edits", () => {
  const onUpdate = vi.fn();
  const props = {
    block,
    disabled: false,
    tool: { ...DEFAULT_LETTERING_TOOL, blockId: block.id },
    onChange: vi.fn(),
    onUpdate,
  };
  const view = render(<GeneratedLetteringControls {...props} />);
  const width = screen.getByRole("spinbutton", { name: "외곽선 두께" });
  expect(screen.queryByRole("slider")).toBeNull();
  fireEvent.change(width, {
    target: { value: "6.5" },
  });
  fireEvent.blur(width);
  expect(onUpdate).toHaveBeenLastCalledWith({
    generatedLettering: {
      ...block.generatedLettering,
      outline: { width: 6.5, color: "#ffffff" },
    },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "외곽선 색상 HEX" }), {
    target: { value: "#FF2211" },
  });
  expect(onUpdate.mock.lastCall?.[0].generatedLettering.outline.color).toBe(
    "#ff2211",
  );
  expect(
    onUpdate.mock.calls.every(
      ([patch]) => Object.keys(patch).join() === "generatedLettering",
    ),
  ).toBe(true);
  view.rerender(<GeneratedLetteringControls {...props} disabled />);
  expect(
    (
      screen.getByRole("spinbutton", {
        name: "외곽선 두께",
      }) as HTMLInputElement
    ).disabled,
  ).toBe(true);
});

it("uses numeric step buttons and commits bounded brush size and percentage values", () => {
  const onChange = vi.fn();
  render(
    <GeneratedLetteringControls
      block={block}
      disabled={false}
      tool={{ ...DEFAULT_LETTERING_TOOL, blockId: block.id }}
      onChange={onChange}
      onUpdate={vi.fn()}
    />,
  );
  expect(screen.queryByRole("slider")).toBeNull();
  const increase = screen.getByRole("button", { name: "크기 늘리기" });
  fireEvent.click(increase);
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ size: 25 }),
  );
  const size = screen.getByRole("spinbutton", { name: "크기" });
  fireEvent.change(size, { target: { value: "800" } });
  fireEvent.blur(size);
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ size: 400 }),
  );
  const softness = screen.getByRole("spinbutton", { name: "부드러움" });
  fireEvent.change(softness, { target: { value: "75" } });
  fireEvent.keyDown(softness, { key: "Enter" });
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ softness: 0.75 }),
  );
});

it("commits colored paint and its mask as one edit without touching the original PNG or outline", () => {
  const preview = createWorkspaceInteractionPreviewStore();
  const onUpdate = vi.fn();
  const tool = {
    ...DEFAULT_LETTERING_TOOL,
    blockId: block.id,
    mode: "paint" as const,
    color: "#ee4422",
    size: 20,
  };
  const { result } = renderHook(() =>
    useLetteringStroke(page, block, { tool, onUpdate }, preview),
  );
  act(() => result.current.start(event(300, 300)));
  act(() => result.current.update(event(320, 340)));
  expect(onUpdate).not.toHaveBeenCalled();
  act(() => result.current.end(event(330, 340)));
  const artwork = onUpdate.mock.lastCall?.[0].generatedLettering;
  expect(artwork).toMatchObject({
    dataUrl: block.generatedLettering?.dataUrl,
    outline: { width: 3 },
    paintStrokes: [{ color: "#ee4422", radiusX: 25, radiusY: 25 }],
    maskStrokes: [{ space: "asset", mode: "restore" }],
  });
  expect(artwork.paintStrokes[0].points).toEqual(artwork.maskStrokes[0].points);
  expect(generatedLettering.safeParse(artwork).success).toBe(true);
  expect(block.generatedLettering?.paintStrokes).toBeUndefined();
  expect(preview.getBlockPreview(block.id)).toBeNull();
});

it("cancels unfinished paint without publishing a partial stroke", () => {
  const onUpdate = vi.fn();
  const { result } = renderHook(() =>
    useLetteringStroke(
      page,
      block,
      { tool: { ...DEFAULT_LETTERING_TOOL, mode: "paint" }, onUpdate },
      createWorkspaceInteractionPreviewStore(),
    ),
  );
  act(() => result.current.start(event(300, 300)));
  act(() => result.current.cancel());
  act(() => result.current.end(event(320, 340)));
  expect(onUpdate).not.toHaveBeenCalled();
});

it("applies the outline to the combined masked image and paint, while legacy images keep their original render path", () => {
  const paint = {
    color: "#123456",
    shape: "circle" as const,
    radiusX: 25,
    radiusY: 25,
    softness: 0,
    points: [{ x: 500, y: 500 }],
  };
  const artwork = generatedLettering.parse({
    ...block.generatedLettering,
    paintStrokes: [paint],
  });
  const { container, rerender } = render(
    <GeneratedLetteringImage
      block={{ ...block, generatedLettering: artwork }}
      className="image"
      nativeSize={{ width: 400, height: 200 }}
    />,
  );
  const images = [...container.querySelectorAll("img")];
  expect(images).toHaveLength(2);
  expect(images[0].parentElement).toBe(images[1].parentElement);
  expect(images[0].parentElement?.parentElement?.style.filter).toContain(
    "#lettering-outline-",
  );
  expect(container.querySelector("feMorphology")?.getAttribute("radius")).toBe(
    "0.0075 0.015",
  );
  expect(decodeURIComponent(images[1].src)).toContain('fill="#123456"');
  rerender(
    <GeneratedLetteringImage
      block={{
        ...block,
        generatedLettering: {
          ...artwork,
          paintStrokes: undefined,
          outline: undefined,
        },
      }}
      className="image"
      nativeSize={{ width: 400, height: 200 }}
    />,
  );
  expect(container.children).toHaveLength(1);
  expect(container.firstElementChild?.tagName).toBe("IMG");
});

it("validates portable correction data and clones image-space edits when relocating", () => {
  const paint = {
    color: "#123456",
    shape: "circle" as const,
    radiusX: 25,
    radiusY: 25,
    softness: 0,
    points: [{ x: 500, y: 500 }],
  };
  const artwork = generatedLettering.parse({
    ...block.generatedLettering,
    paintStrokes: [paint],
  });
  expect(
    generatedLettering.safeParse(JSON.parse(JSON.stringify(artwork))).success,
  ).toBe(true);
  expect(
    generatedLettering.safeParse({
      ...artwork,
      outline: { width: Infinity, color: "#ffffff" },
    }).success,
  ).toBe(false);
  expect(
    generatedLettering.safeParse({
      ...artwork,
      paintStrokes: [{ ...paint, color: '"/><script/>' }],
    }).success,
  ).toBe(false);
  expect(
    letteringPaintSvg([{ ...paint, color: '"/><script/>' }]),
  ).not.toContain("script");
  const relocated = relocateGeneratedLettering(artwork, block.bbox, {
    x: 0,
    y: 0,
    w: 200,
    h: 200,
  });
  expect(relocated?.paintStrokes).toEqual(artwork.paintStrokes);
  expect(relocated?.paintStrokes).not.toBe(artwork.paintStrokes);
});
