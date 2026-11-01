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
import { EditorPanel } from "../src/renderer/src/components/EditorPanel";
import { OverlayBlock } from "../src/renderer/src/components/OverlayBlock";
import { PageArtwork } from "../src/renderer/src/components/PageArtwork";
import {
  resolveStylePresetEditorValues,
  updateStylePresetFromEditor,
} from "../src/renderer/src/components/settingsModal/stylePresetEditing";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import { createWorkspaceInteractionPreviewStore } from "../src/renderer/src/lib/workspaceInteractionPreview";
import {
  parseStoredAppSettings,
  resolveDefaultAppSettings,
} from "../src/main/appSettings";
import {
  DEFAULT_BLOCK_FORMAT_DEFAULTS,
  pickBlockFormat,
} from "../src/shared/blockFormat";
import {
  createBlockLibrarySaveInput,
  instantiateBlockLibraryEntry,
} from "../src/shared/blockLibrary";
import {
  createBlockStylePreset,
  normalizeBlockStylePresets,
  resolveBlockStylePresetPatch,
  type BlockStylePreset,
} from "../src/shared/blockStylePresets";
import { TranslationBlockSchema } from "../src/shared/ipcSchemaPrimitives";
import { AppSettingsSchema } from "../src/shared/ipcSettingsSchemas";
import { PanelCommandSchema } from "../src/shared/panelBridgeSchemas";
import {
  buildPanelFormatSelection,
  createPanelSelectionKey,
  pickPanelFormatPatch,
} from "../src/shared/panelBridgeTypes";
import { resolveTextBackgroundOpacity } from "../src/shared/textBackground";
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

afterAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: originalGetContext,
  });
  vi.unstubAllGlobals();
});

function backgroundBlock(
  patch: Partial<TranslationBlock> = {},
): TranslationBlock {
  return makeBlock(false, {
    translatedText: "배경",
    textBackgroundEnabled: true,
    textBackgroundColor: "#ff0000",
    ...patch,
  });
}

describe("text-area background opacity", () => {
  it("defaults legacy and invalid values to an opaque fill", () => {
    expect(resolveTextBackgroundOpacity({})).toBe(1);
    expect(resolveTextBackgroundOpacity({ textBackgroundOpacity: NaN })).toBe(
      1,
    );
    expect(resolveTextBackgroundOpacity({ textBackgroundOpacity: 0 })).toBe(0);
    expect(resolveTextBackgroundOpacity({ textBackgroundOpacity: 0.4 })).toBe(
      0.4,
    );
    expect(resolveTextBackgroundOpacity({ textBackgroundOpacity: 2 })).toBe(1);
  });

  it("fades only the background fill, identically in export and editor", () => {
    const page = {
      id: "page-opacity",
      name: "page.png",
      width: 1000,
      height: 1000,
      blocks: [
        { ...backgroundBlock({ textBackgroundOpacity: 0.4 }), id: "faded" },
        { ...backgroundBlock({ textBackgroundOpacity: 0 }), id: "clear" },
        { ...backgroundBlock(), id: "legacy" },
      ],
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
    const layers = Array.from(
      exported.container.querySelectorAll<HTMLElement>(
        ".text-background-layer",
      ),
    );
    expect(
      layers.map((layer) => [layer.style.backgroundColor, layer.style.opacity]),
    ).toEqual([
      ["rgb(255, 0, 0)", "0.4"],
      ["rgb(255, 0, 0)", "0"],
      // Legacy documents keep exactly their previous style.
      ["rgb(255, 0, 0)", ""],
    ]);
    for (const layer of layers) {
      const block = layer.closest<HTMLElement>(".overlay-block");
      expect(block?.style.opacity ?? "").toBe("");
      const text = block?.querySelector<HTMLElement>(".overlay-text");
      expect(text).not.toBeNull();
      expect(text?.contains(layer)).toBe(false);
      expect(text?.style.opacity ?? "").not.toBe("0.4");
    }

    const editor = render(
      withFonts(
        <>
          {page.blocks.map((block) => (
            <OverlayBlock
              block={block}
              interactionPreviewStore={createWorkspaceInteractionPreviewStore()}
              key={block.id}
              onPointerDown={() => undefined}
              onResizePointerDown={() => undefined}
              pageSize={{ width: page.width, height: page.height }}
              pointerDisabled
              selected={false}
              showChrome={false}
              stageSize={visualSize}
              textLayoutStageSize={{ width: page.width, height: page.height }}
            />
          ))}
        </>,
      ),
    );
    expect(
      Array.from(
        editor.container.querySelectorAll<HTMLElement>(
          ".text-background-layer",
        ),
        (layer) => layer.style.opacity,
      ),
    ).toEqual(["0.4", "0", ""]);
  });

  it("validates the stored block and detached-panel patch", () => {
    const block = backgroundBlock({ textBackgroundOpacity: 0.4 });
    expect(TranslationBlockSchema.parse(block).textBackgroundOpacity).toBe(0.4);
    expect(
      TranslationBlockSchema.safeParse({ ...block, textBackgroundOpacity: 1.5 })
        .success,
    ).toBe(false);
    expect(TranslationBlockSchema.parse(backgroundBlock())).not.toHaveProperty(
      "textBackgroundOpacity",
    );

    const patch = pickPanelFormatPatch({ textBackgroundOpacity: 0.25 });
    expect(patch).toEqual({ textBackgroundOpacity: 0.25 });
    expect(
      PanelCommandSchema.parse({
        type: "updateSelectionFormat",
        selectionKey: createPanelSelectionKey([block.id]),
        patch,
      }),
    ).toMatchObject({ patch });
  });

  it("treats an absent value as opaque when comparing a multi-selection", () => {
    const legacy = backgroundBlock();
    const opaque = backgroundBlock({ textBackgroundOpacity: 1 });
    const faded = backgroundBlock({ textBackgroundOpacity: 0.4 });

    const same = buildPanelFormatSelection([legacy, opaque]);
    expect(same.mixedFields).not.toContain("textBackgroundOpacity");
    expect(same.common.textBackgroundOpacity).toBe(1);
    expect(buildPanelFormatSelection([legacy, faded]).mixedFields).toContain(
      "textBackgroundOpacity",
    );
  });

  it("copies with the color format group and the block library", () => {
    const block = backgroundBlock({ textBackgroundOpacity: 0.4 });
    expect(pickBlockFormat(block, ["color"])).toMatchObject({
      textBackgroundEnabled: true,
      textBackgroundColor: "#ff0000",
      textBackgroundOpacity: 0.4,
    });

    const input = createBlockLibrarySaveInput(block, {
      width: 1000,
      height: 1000,
    });
    expect(input.block.textBackgroundOpacity).toBe(0.4);
    const instantiated = instantiateBlockLibraryEntry(
      {
        id: "entry",
        name: input.name,
        createdAt: "2026-10-22T00:00:00.000Z",
        updatedAt: "2026-10-22T00:00:00.000Z",
        block: input.block,
      } as Parameters<typeof instantiateBlockLibraryEntry>[0],
      "copy",
    );
    expect(instantiated.textBackgroundOpacity).toBe(0.4);
  });

  it("stores the opacity in style presets and keeps older presets opaque", () => {
    const preset = createBlockStylePreset({
      block: backgroundBlock({ textBackgroundOpacity: 0.4 }),
      groupIds: ["color"],
      id: "style-preset:faded",
      name: "반투명 배경",
    });
    expect(preset.format.textBackgroundOpacity).toBe(0.4);
    expect(resolveBlockStylePresetPatch(preset)).toMatchObject({
      textBackgroundEnabled: true,
      textBackgroundOpacity: 0.4,
    });

    // A preset saved before the setting existed meant an opaque fill.
    const legacy: BlockStylePreset = {
      ...preset,
      id: "style-preset:legacy-background",
      format: {
        textColor: "#111111",
        textBackgroundEnabled: true,
        textBackgroundColor: "#ff0000",
      },
    };
    expect(resolveBlockStylePresetPatch(legacy).textBackgroundOpacity).toBe(1);
    // Presets without any background definition never add one.
    const textOnly = createBlockStylePreset({
      block: makeBlock(false),
      groupIds: ["color"],
      id: "style-preset:text-only",
      name: "글자색",
    });
    expect(textOnly.format).not.toHaveProperty("textBackgroundOpacity");
    expect(resolveBlockStylePresetPatch(textOnly)).not.toHaveProperty(
      "textBackgroundOpacity",
    );

    const [normalized] = normalizeBlockStylePresets([
      { ...preset, format: { ...preset.format, textBackgroundOpacity: 3 } },
    ]);
    expect(normalized?.format.textBackgroundOpacity).toBe(1);
    const defaults = resolveDefaultAppSettings();
    const restored = parseStoredAppSettings(
      JSON.stringify({ ...defaults, blockStylePresets: [preset] }),
      defaults,
    );
    expect(restored.blockStylePresets).toEqual([preset]);
    expect(AppSettingsSchema.safeParse(restored).success).toBe(true);
  });

  it("edits the opacity in the preset editor without adding it elsewhere", () => {
    const preset = createBlockStylePreset({
      block: backgroundBlock(),
      groupIds: ["color"],
      id: "style-preset:edit",
      name: "배경",
    });
    expect(
      resolveStylePresetEditorValues(DEFAULT_BLOCK_FORMAT_DEFAULTS, preset)
        .textBackgroundOpacity,
    ).toBe(1);
    const edited = updateStylePresetFromEditor(
      preset,
      DEFAULT_BLOCK_FORMAT_DEFAULTS,
      { textBackgroundOpacity: 0.6 },
    );
    expect(edited.format.textBackgroundOpacity).toBe(0.6);

    const untouched = updateStylePresetFromEditor(
      { ...preset, format: { textColor: "#111111" } },
      DEFAULT_BLOCK_FORMAT_DEFAULTS,
      { textColor: "#222222" },
    );
    expect(untouched.format).not.toHaveProperty("textBackgroundOpacity");
  });

  it("edits a percentage from the editor panel as a format change", () => {
    const onUpdateFormat = vi.fn();
    const view = render(panel(backgroundBlock(), onUpdateFormat));
    const input = screen.getByRole("spinbutton", {
      name: "글자 영역 배경 불투명도",
    });
    expect(input).toHaveProperty("value", "100");

    fireEvent.change(input, { target: { value: "40" } });
    fireEvent.blur(input);
    expect(onUpdateFormat).toHaveBeenLastCalledWith({
      textBackgroundOpacity: 0.4,
    });

    view.rerender(
      panel(backgroundBlock({ textBackgroundEnabled: false }), onUpdateFormat),
    );
    // Off keeps the cell in place, so enabling never shifts the layout.
    expect(
      screen.getByRole("spinbutton", { name: "글자 영역 배경 불투명도" }),
    ).toHaveProperty("disabled", true);
  });

  it("marks a mixed selection and applies one value to every block", () => {
    const onUpdateFormat = vi.fn();
    render(
      panel(backgroundBlock(), onUpdateFormat, {
        selectedBlockCount: 2,
        mixedFields: ["textBackgroundOpacity"],
      }),
    );
    const input = screen.getByRole("spinbutton", {
      name: "글자 영역 배경 불투명도",
    });
    expect(input).toHaveProperty("value", "");

    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(onUpdateFormat).toHaveBeenLastCalledWith({
      textBackgroundOpacity: 0,
    });
  });
});

function panel(
  block: TranslationBlock,
  onUpdateFormat: (patch: Partial<TranslationBlock>) => void,
  selection: {
    selectedBlockCount?: number;
    mixedFields?: ("textBackgroundOpacity" | "textBackgroundEnabled")[];
  } = {},
): React.JSX.Element {
  return withFonts(
    <EditorPanel
      block={block}
      disabled={false}
      selectedBlockCount={selection.selectedBlockCount ?? 1}
      formatSelection={{
        common: {},
        mixedFields: selection.mixedFields ?? [],
      }}
      onAdjustFontSize={vi.fn()}
      onDelete={vi.fn()}
      onDuplicate={vi.fn()}
      onUpdate={vi.fn()}
      onUpdateFormat={onUpdateFormat}
    />,
  );
}

function withFonts(children: React.ReactNode): React.JSX.Element {
  return (
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
      {children}
    </FontsContext.Provider>
  );
}
