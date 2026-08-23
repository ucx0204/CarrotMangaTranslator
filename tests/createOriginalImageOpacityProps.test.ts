import { describe, expect, it, vi } from "vitest";
import { createOriginalImageOpacityProps } from "../src/renderer/src/app/session/createOriginalImageOpacityProps";

type OriginalOpacityInput = Parameters<
  typeof createOriginalImageOpacityProps
>[0];

function asOriginalOpacityInput(value: unknown): OriginalOpacityInput {
  return value as OriginalOpacityInput;
}

function createInput(selectedPageId: string | null) {
  const setOriginalImageOpacityForPage = vi.fn();
  const selectedPage = selectedPageId
    ? {
        id: selectedPageId,
        imagePath: "original.png",
        inpaintedImagePath: "inpainted.png",
      }
    : null;
  return {
    input: asOriginalOpacityInput({
      derivedState: {
        selectedPage,
        selectedPageImageDataUrl: "data:image/png;base64,inpainted",
        selectedPageImageDataUrlPageId: selectedPageId,
        selectedPageOriginalImageDataUrl: "data:image/png;base64,original",
        selectedPageOriginalImageDataUrlPageId: selectedPageId,
      },
      uiState: {
        originalImageOpacityByPage: selectedPageId
          ? { [selectedPageId]: 0.35 }
          : {},
        setOriginalImageOpacityForPage,
      },
    }),
    setOriginalImageOpacityForPage,
  };
}

describe("createOriginalImageOpacityProps", () => {
  it("projects the selected page value and update action", () => {
    const { input, setOriginalImageOpacityForPage } = createInput("page-1");
    const props = createOriginalImageOpacityProps(input);

    expect(props.originalImageOpacity).toBe(0.35);
    expect(props.originalImageOpacityAvailable).toBe(true);
    props.onChangeOriginalImageOpacity(0.6);
    expect(setOriginalImageOpacityForPage).toHaveBeenCalledWith("page-1", 0.6);
  });

  it("returns a disabled zero value when no page is selected", () => {
    const { input, setOriginalImageOpacityForPage } = createInput(null);
    const props = createOriginalImageOpacityProps(input);

    expect(props.originalImageOpacity).toBe(0);
    expect(props.originalImageOpacityAvailable).toBe(false);
    props.onChangeOriginalImageOpacity(0.6);
    expect(setOriginalImageOpacityForPage).not.toHaveBeenCalled();
  });
});
