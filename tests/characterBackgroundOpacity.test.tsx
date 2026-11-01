/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { EditorCharacterEffectControls } from "../src/renderer/src/components/EditorCharacterEffectControls";
import type { CharacterFormatTarget } from "../src/renderer/src/components/editorCharacterFormatTarget";
import { OverlayBlock } from "../src/renderer/src/components/OverlayBlock";
import { PageArtwork } from "../src/renderer/src/components/PageArtwork";
import { resolveRichTranslationSelectionValues } from "../src/renderer/src/components/richTranslationSelectionModel";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import {
  extractRichTextEditorRuns,
  renderRichTextEditorRuns,
} from "../src/renderer/src/lib/richTextEditorDom";
import {
  resolveMainRunVisualStyle,
  resolveRunBackgroundFill,
} from "../src/renderer/src/lib/textRunVisualStyles";
import { createWorkspaceInteractionPreviewStore } from "../src/renderer/src/lib/workspaceInteractionPreview";
import { applyBlockCharacterFormat } from "../src/shared/richTextBlockFormatting";
import {
  applyTextStyleToRuns,
  parseRichText,
  serializeRichTextRuns,
} from "../src/shared/richTextMarkup";
import type { TranslationBlock } from "../src/shared/textTypes";
import { makeBlock } from "./helpers/workspacePointerFixtures";

const originalGetContext = HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      font: "",
      measureText: (text: string) => ({ width: Array.from(text).length * 11 }),
    }),
  });
});

afterEach(cleanup);

afterAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: originalGetContext,
  });
});

const FADED =
  "[background=#ff0000][background-opacity=0.4]나[/background-opacity][/background]";

describe("letter background opacity markup", () => {
  it("keeps legacy letter backgrounds opaque and round-trips the opacity", () => {
    const legacy = parseRichText("가[background=#ff0000]나[/background]다");
    expect(legacy.runs[1]).toMatchObject({ backgroundColor: "#ff0000" });
    expect(legacy.runs[1]).not.toHaveProperty("backgroundOpacity");
    expect(serializeRichTextRuns(legacy.runs)).toBe(
      "가[background=#ff0000]나[/background]다",
    );

    const faded = parseRichText(`가${FADED}다`);
    expect(faded.plainText).toBe("가나다");
    expect(faded.runs[1]).toMatchObject({
      text: "나",
      backgroundColor: "#ff0000",
      backgroundOpacity: 0.4,
    });
    const serialized = serializeRichTextRuns(faded.runs);
    expect(serialized).toBe(`가${FADED}다`);
    expect(parseRichText(serialized).runs).toEqual(faded.runs);

    // Out-of-range values are not markup, exactly like the other opacities.
    expect(
      parseRichText("[background-opacity=1.5]나[/background-opacity]")
        .plainText,
    ).toBe("[background-opacity=1.5]나[/background-opacity]");
  });

  it("changes only the selected range and clears with the background", () => {
    const runs = parseRichText("[background=#ff0000]가나다[/background]").runs;
    const faded = applyTextStyleToRuns(runs, 1, 2, { backgroundOpacity: 0 });
    expect(
      faded.map((run) => [
        run.text,
        run.backgroundColor,
        run.backgroundOpacity,
      ]),
    ).toEqual([
      ["가", "#ff0000", undefined],
      ["나", "#ff0000", 0],
      ["다", "#ff0000", undefined],
    ]);

    const cleared = applyTextStyleToRuns(faded, 0, 3, {
      backgroundColor: null,
      backgroundOpacity: null,
    });
    expect(serializeRichTextRuns(cleared)).toBe("가나다");
  });

  it("applies block-wide letter formatting to every letter only", () => {
    const block = makeBlock(false, {
      translatedText: "[background=#ff0000]가[/background]나",
      textOpacity: 0.8,
    });
    const patch = applyBlockCharacterFormat(block, { backgroundOpacity: 0.5 });
    // The letter fill fades; the glyph opacity stays on the block.
    expect(patch).not.toHaveProperty("textOpacity");
    const runs = parseRichText(String(patch.translatedText)).runs;
    expect(runs.map((run) => [run.text, run.backgroundOpacity])).toEqual([
      ["가", 0.5],
      ["나", 0.5],
    ]);
    expect(runs[0]?.backgroundColor).toBe("#ff0000");
    expect(runs[1]).not.toHaveProperty("backgroundColor");
  });

  it("survives the visual editor's DOM round trip", () => {
    const runs = parseRichText(`가${FADED}`).runs;
    const root = document.createElement("div");
    renderRichTextEditorRuns(root, runs, {
      baseBold: false,
      baseItalic: false,
      baseFontSizePx: 24,
      baseFontFamily: "sans-serif",
      baseOpacity: 1,
      resolveFontFamily: () => "sans-serif",
    });
    expect(extractRichTextEditorRuns(root)).toEqual(runs);
  });
});

describe("letter background opacity rendering", () => {
  it("fades only the fill color, never the glyph", () => {
    expect(resolveRunBackgroundFill({})).toBeUndefined();
    expect(resolveRunBackgroundFill({ backgroundColor: "#ff0000" })).toBe(
      "#ff0000",
    );
    expect(
      resolveRunBackgroundFill({
        backgroundColor: "#ff0000",
        backgroundOpacity: 1,
      }),
    ).toBe("#ff0000");
    expect(
      resolveRunBackgroundFill({
        backgroundColor: "#ff0000",
        backgroundOpacity: 0.4,
      }),
    ).toBe("rgba(255, 0, 0, 0.4)");
    expect(
      resolveRunBackgroundFill({
        backgroundColor: "#ff0000",
        backgroundOpacity: 0,
      }),
    ).toBe("rgba(255, 0, 0, 0)");

    const block = makeBlock(false, { textColor: "#111111" });
    const style = resolveMainRunVisualStyle(
      block,
      {
        text: "나",
        bold: false,
        italic: false,
        backgroundColor: "#ff0000",
        backgroundOpacity: 0.4,
        opacity: 0.9,
      },
      24,
      "horizontal",
    );
    expect(style.backgroundColor).toBe("rgba(255, 0, 0, 0.4)");
    expect(style.color).toBe("#111111");
    expect(style).not.toHaveProperty("opacity");
  });

  it("renders the same faded letter fill in export and editor", () => {
    const block: TranslationBlock = {
      ...makeBlock(false, { translatedText: `가${FADED}다` }),
      id: "letters",
    };
    const page = {
      id: "page-letter-bg",
      name: "page.png",
      width: 1000,
      height: 1000,
      blocks: [block],
    };
    const visualSize = { width: 1000, height: 1000 };
    const exported = render(
      <PageArtwork
        fontCatalog={DEFAULT_BLOCK_FONT_CATALOG}
        imageSrc="data:image/png;base64,"
        page={page}
        visualSize={visualSize}
      />,
    );
    const fills = (container: HTMLElement) =>
      Array.from(container.querySelectorAll<HTMLElement>("span"))
        .map((span) => span.style.backgroundColor)
        .filter(Boolean);
    expect(fills(exported.container)).toContain("rgba(255, 0, 0, 0.4)");
    // The full-area background stays off and independent.
    expect(
      exported.container.querySelector(".text-background-layer"),
    ).toBeNull();

    const editor = render(
      <FontsContext.Provider
        value={{
          baseOptions: [],
          busy: false,
          catalog: DEFAULT_BLOCK_FONT_CATALOG,
          options: [],
          registerFont: async () => undefined,
          removeFont: async () => undefined,
          savePreferences: async () => undefined,
        }}
      >
        <OverlayBlock
          block={block}
          interactionPreviewStore={createWorkspaceInteractionPreviewStore()}
          onPointerDown={() => undefined}
          onResizePointerDown={() => undefined}
          pageSize={{ width: page.width, height: page.height }}
          pointerDisabled
          selected={false}
          showChrome={false}
          stageSize={visualSize}
          textLayoutStageSize={{ width: page.width, height: page.height }}
        />
      </FontsContext.Provider>,
    );
    expect(fills(editor.container)).toEqual(fills(exported.container));
  });
});

describe("letter background opacity controls", () => {
  it("reports the selection's value and mixed ranges separately", () => {
    const block = makeBlock(false, { translatedText: `가${FADED}다` });
    const runs = parseRichText(block.translatedText).runs;
    const only = resolveRichTranslationSelectionValues(
      runs,
      { start: 1, end: 2 },
      block,
      null,
      null,
    );
    expect(only.backgroundEnabled).toBe(true);
    expect(only.backgroundOpacityPercent).toBe(40);
    expect(only.mixedFields).not.toContain("backgroundOpacityPercent");
    // The glyph's own opacity is a different value.
    expect(only.opacityPercent).toBe(100);

    const mixed = resolveRichTranslationSelectionValues(
      parseRichText(`[background=#ff0000]가[/background]${FADED}`).runs,
      { start: 0, end: 2 },
      block,
      null,
      null,
    );
    expect(mixed.mixedFields).toContain("backgroundOpacityPercent");
    expect(mixed.mixedFields).not.toContain("backgroundColor");
  });

  it("edits, resets and clears only the letter background", () => {
    const apply = vi.fn();
    const view = render(
      <EditorCharacterEffectControls
        disabled={false}
        target={target(apply, { backgroundEnabled: true })}
      />,
    );
    const opacity = screen.getByRole("spinbutton", {
      name: "글자 배경 불투명도",
    });
    expect(opacity).toHaveProperty("value", "100");

    fireEvent.change(opacity, { target: { value: "40" } });
    fireEvent.blur(opacity);
    expect(apply).toHaveBeenLastCalledWith({ backgroundOpacity: 0.4 });

    view.rerender(
      <EditorCharacterEffectControls
        disabled={false}
        target={target(apply, {
          backgroundEnabled: true,
          backgroundOpacityPercent: 40,
        })}
      />,
    );
    // 100% is the legacy opaque fill, stored as no value.
    const reset = screen.getByRole("spinbutton", {
      name: "글자 배경 불투명도",
    });
    fireEvent.change(reset, { target: { value: "100" } });
    fireEvent.blur(reset);
    expect(apply).toHaveBeenLastCalledWith({ backgroundOpacity: null });

    fireEvent.click(screen.getByRole("checkbox", { name: "글자 배경" }));
    expect(apply).toHaveBeenLastCalledWith({
      backgroundColor: null,
      backgroundOpacity: null,
    });
  });

  it("keeps the off state in place and shows a mixed opacity", () => {
    const apply = vi.fn();
    const view = render(
      <EditorCharacterEffectControls
        disabled={false}
        target={target(apply, { backgroundEnabled: false })}
      />,
    );
    expect(
      screen.getByRole("spinbutton", { name: "글자 배경 불투명도" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox", { name: "글자 배경" }));
    expect(apply).toHaveBeenLastCalledWith({ backgroundColor: "#ffffff" });

    view.rerender(
      <EditorCharacterEffectControls
        disabled={false}
        target={target(apply, { backgroundEnabled: true }, [
          "backgroundOpacityPercent",
        ])}
      />,
    );
    expect(
      screen.getByRole("spinbutton", { name: "글자 배경 불투명도" }),
    ).toHaveProperty("value", "");
  });
});

function target(
  apply: CharacterFormatTarget["apply"],
  overrides: Partial<CharacterFormatTarget["values"]>,
  mixed: readonly string[] = [],
): CharacterFormatTarget {
  const block = makeBlock(false, { translatedText: "가나다" });
  return {
    scope: "selection",
    blockCount: 1,
    codeMode: false,
    values: {
      ...resolveRichTranslationSelectionValues(
        [],
        { start: 0, end: 0 },
        block,
        null,
        null,
      ),
      ...overrides,
    },
    mixed: new Set(mixed) as CharacterFormatTarget["mixed"],
    supportsCharacterBackground: true,
    apply,
  };
}
