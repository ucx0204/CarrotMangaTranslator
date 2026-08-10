import { describe, expect, it } from "vitest";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../src/shared/blockFormat";
import { createBlockStylePresetFromDefaults } from "../src/shared/blockStylePresets";
import {
  resolveStylePresetEditorValues,
  setStylePresetGroupEnabled,
  updateStylePresetFromEditor,
} from "../src/renderer/src/components/settingsModal/stylePresetEditing";

describe("inline style preset editing", () => {
  it("expands partial presets without mutating the defaults", () => {
    const defaults = { ...DEFAULT_BLOCK_FORMAT_DEFAULTS, fontSizePx: 31 };
    const preset = createBlockStylePresetFromDefaults({
      defaults,
      groupIds: ["color"],
      name: "대사",
    });
    const values = resolveStylePresetEditorValues(defaults, preset);

    expect(values.fontSizePx).toBe(31);
    expect(values.textColor).toBe(defaults.textColor);
    expect(defaults.fontSizePx).toBe(31);
  });

  it("adds only the edited group and preserves unrelated preset fields", () => {
    const preset = {
      ...createBlockStylePresetFromDefaults({
        defaults: DEFAULT_BLOCK_FORMAT_DEFAULTS,
        groupIds: ["transform", "color"],
        name: "효과음",
      }),
      format: {
        rotationDeg: 18,
        textOpacity: 0.8,
        textColor: "#ee1122",
      },
    };
    const updated = updateStylePresetFromEditor(
      preset,
      DEFAULT_BLOCK_FORMAT_DEFAULTS,
      { fontSizePx: 42, autoFitText: false },
    );

    expect(updated.groupIds).toEqual(["size", "color", "transform"]);
    expect(updated.format).toMatchObject({
      autoFitText: false,
      fontSizePx: 42,
      rotationDeg: 18,
      textOpacity: 0.8,
      textColor: "#ee1122",
    });
  });

  it("preserves rotation when opacity changes in the same transform group", () => {
    const preset = {
      ...createBlockStylePresetFromDefaults({
        defaults: DEFAULT_BLOCK_FORMAT_DEFAULTS,
        groupIds: ["transform"],
        name: "회전",
      }),
      format: { rotationDeg: -24, textOpacity: 0.7 },
    };
    const updated = updateStylePresetFromEditor(
      preset,
      DEFAULT_BLOCK_FORMAT_DEFAULTS,
      { textOpacity: 0.4 },
    );

    expect(updated.format).toMatchObject({
      rotationDeg: -24,
      textOpacity: 0.4,
    });
  });

  it("enables and disables groups without leaving stale format fields", () => {
    const preset = createBlockStylePresetFromDefaults({
      defaults: DEFAULT_BLOCK_FORMAT_DEFAULTS,
      groupIds: ["color"],
      name: "부분",
    });
    const enabled = setStylePresetGroupEnabled(
      preset,
      DEFAULT_BLOCK_FORMAT_DEFAULTS,
      "direction",
      true,
    );
    expect(enabled.groupIds).toEqual(["direction", "color"]);
    expect(enabled.format.renderDirection).toBe("horizontal");

    const disabled = setStylePresetGroupEnabled(
      enabled,
      DEFAULT_BLOCK_FORMAT_DEFAULTS,
      "color",
      false,
    );
    expect(disabled.groupIds).toEqual(["direction"]);
    expect(disabled.format).not.toHaveProperty("textColor");
  });

  it("never removes the final enabled group", () => {
    const preset = createBlockStylePresetFromDefaults({
      defaults: DEFAULT_BLOCK_FORMAT_DEFAULTS,
      groupIds: ["color"],
      name: "최소 프리셋",
    });

    expect(
      setStylePresetGroupEnabled(
        preset,
        DEFAULT_BLOCK_FORMAT_DEFAULTS,
        "color",
        false,
      ),
    ).toBe(preset);
  });
});
