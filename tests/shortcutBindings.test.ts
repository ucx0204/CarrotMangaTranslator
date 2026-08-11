import { describe, expect, it } from "vitest";
import {
  comboFromEvent,
  comboFromWheelEvent,
  formatCombo,
} from "../src/renderer/src/lib/shortcuts/comboFromEvent";
import {
  assignBinding,
  effectiveCombo,
  effectiveCombosForAction,
  resetBinding,
  resolveBindings,
  sanitizeKeybindingOverrides,
} from "../src/renderer/src/lib/shortcuts/shortcutBindingResolution";
import { SHORTCUT_ACTIONS } from "../src/renderer/src/lib/shortcuts/shortcutActions";
import {
  isCanonicalKeybindingCombo,
  normalizeStoredKeybindingOverrides,
  SHORTCUT_ACTION_IDS,
} from "../src/shared/shortcutSettings";

function event(
  overrides: Partial<{
    key: string;
    code: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }>,
) {
  return {
    key: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("comboFromEvent", () => {
  it("normalizes plain alphanumeric keys", () => {
    expect(comboFromEvent(event({ key: "b" }))).toBe("b");
    expect(comboFromEvent(event({ key: "B" }))).toBe("b");
    expect(comboFromEvent(event({ key: "1" }))).toBe("1");
  });

  it("uses the physical letter key while a Korean IME is active", () => {
    expect(comboFromEvent(event({ key: "ㅠ", code: "KeyB" }))).toBe("b");
    expect(
      comboFromEvent(event({ key: "ㅠ", code: "KeyB", shiftKey: true })),
    ).toBe("shift+b");
    expect(comboFromEvent(event({ key: "ㅍ", code: "KeyV" }))).toBe("v");
  });

  it("adds a shift token for shifted alphanumeric keys", () => {
    expect(comboFromEvent(event({ key: "T", shiftKey: true }))).toBe("shift+t");
  });

  it("unifies ctrl and meta and orders modifiers", () => {
    expect(comboFromEvent(event({ key: "z", ctrlKey: true }))).toBe("ctrl+z");
    expect(comboFromEvent(event({ key: "k", metaKey: true }))).toBe("ctrl+k");
    expect(
      comboFromEvent(event({ key: "Z", ctrlKey: true, shiftKey: true })),
    ).toBe("ctrl+shift+z");
  });

  it("keeps symbol keys verbatim without a redundant shift token", () => {
    expect(comboFromEvent(event({ key: "?", shiftKey: true }))).toBe("?");
    expect(comboFromEvent(event({ key: ",", ctrlKey: true }))).toBe("ctrl+,");
  });

  it("lowercases named keys", () => {
    expect(comboFromEvent(event({ key: "Delete" }))).toBe("delete");
    expect(comboFromEvent(event({ key: "ArrowLeft" }))).toBe("arrowleft");
  });

  it("keeps numpad plus distinct so it can be bound as a shortcut alias", () => {
    expect(
      comboFromEvent(event({ key: "+", code: "NumpadAdd", ctrlKey: true })),
    ).toBe("ctrl+numpadadd");
  });

  it("ignores pure modifier presses", () => {
    expect(comboFromEvent(event({ key: "Shift", shiftKey: true }))).toBeNull();
    expect(comboFromEvent(event({ key: "Control", ctrlKey: true }))).toBeNull();
  });
});

describe("comboFromWheelEvent", () => {
  it("normalizes wheel direction and ordered modifier combinations", () => {
    expect(
      comboFromWheelEvent({
        deltaX: 0,
        deltaY: -120,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe("wheelup");
    expect(
      comboFromWheelEvent({
        deltaX: 0,
        deltaY: 120,
        ctrlKey: false,
        metaKey: true,
        altKey: true,
        shiftKey: true,
      }),
    ).toBe("ctrl+alt+shift+wheeldown");
  });

  it("uses horizontal delta for Chromium's Shift+physical-wheel form", () => {
    expect(
      comboFromWheelEvent({
        deltaX: -120,
        deltaY: 0,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: true,
      }),
    ).toBe("shift+wheelup");
  });

  it("ignores zero and unmodified horizontal-dominant wheel movement", () => {
    const base = {
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    };
    expect(comboFromWheelEvent({ ...base, deltaX: 0, deltaY: 0 })).toBeNull();
    expect(comboFromWheelEvent({ ...base, deltaX: 80, deltaY: 40 })).toBeNull();
  });
});

describe("formatCombo", () => {
  it("renders display tokens", () => {
    expect(formatCombo("ctrl+shift+t", "Win32")).toEqual([
      "Ctrl",
      "Shift",
      "T",
    ]);
    expect(formatCombo("?", "Win32")).toEqual(["?"]);
    expect(formatCombo("ctrl+,", "Win32")).toEqual(["Ctrl", ","]);
    expect(formatCombo("ctrl+numpadadd", "Win32")).toEqual(["Ctrl", "+"]);
    expect(formatCombo("ctrl+add", "Win32")).toEqual(["Ctrl", "+"]);
    expect(formatCombo("ctrl++", "Win32")).toEqual(["Ctrl", "+"]);
    expect(formatCombo("pageup", "Win32")).toEqual(["Page Up"]);
    expect(formatCombo("alt+wheelup", "Win32")).toEqual(["Alt", "Wheel ↑"]);
    expect(formatCombo("shift+wheeldown", "Win32")).toEqual([
      "Shift",
      "Wheel ↓",
    ]);
    expect(formatCombo("delete", "Win32")).toEqual(["Del"]);
    expect(formatCombo("", "Win32")).toEqual([]);
  });

  it("uses Command glyphs for canonical Ctrl/Meta bindings on macOS", () => {
    expect(formatCombo("ctrl+shift+t", "MacIntel")).toEqual([
      "⌘",
      "Shift",
      "T",
    ]);
    expect(formatCombo("ctrl+,", "MacIntel")).toEqual(["⌘", ","]);
  });
});

describe("shortcut binding resolution", () => {
  it("keeps the renderer registry exhaustive with the shared action-id source", () => {
    expect(SHORTCUT_ACTIONS.map((action) => action.id)).toEqual([
      ...SHORTCUT_ACTION_IDS,
    ]);
  });

  it("accepts only canonical persisted shortcut combos", () => {
    expect(isCanonicalKeybindingCombo("ctrl+alt+shift+b")).toBe(true);
    expect(isCanonicalKeybindingCombo("ctrl+wheelup")).toBe(true);
    expect(isCanonicalKeybindingCombo("alt+wheeldown")).toBe(true);
    expect(isCanonicalKeybindingCombo("ctrl++")).toBe(true);
    expect(isCanonicalKeybindingCombo(" ")).toBe(true);
    expect(isCanonicalKeybindingCombo("")).toBe(true);
    expect(isCanonicalKeybindingCombo("CTRL+B")).toBe(false);
    expect(isCanonicalKeybindingCombo("shift+ctrl+b")).toBe(false);
    expect(isCanonicalKeybindingCombo("ctrl+ctrl+b")).toBe(false);
    expect(isCanonicalKeybindingCombo("  ")).toBe(false);
    expect(isCanonicalKeybindingCombo("ctrl+\n")).toBe(false);
  });

  it("normalizes stored shortcut overrides at the platform-neutral boundary", () => {
    expect(normalizeStoredKeybindingOverrides(null)).toBeNull();
    expect(normalizeStoredKeybindingOverrides("ctrl+b")).toBeNull();
    expect(normalizeStoredKeybindingOverrides(["ctrl+b"])).toBeNull();
    expect(normalizeStoredKeybindingOverrides({})).toEqual({});
    expect(
      normalizeStoredKeybindingOverrides({
        "toggle-block-chrome": "CTRL+SHIFT+B",
        "delete-block": "",
        "open-settings": "shift+ctrl+k",
        "zoom-in": 42,
        "zoom-out": "ALT+WHEELDOWN",
        "removed-action": "ctrl+r",
      }),
    ).toEqual({
      "toggle-block-chrome": "ctrl+shift+b",
      "delete-block": "",
      "zoom-out": "alt+wheeldown",
    });
  });

  it("falls back to the built-in default combo", () => {
    expect(effectiveCombo("toggle-block-chrome", {})).toBe("shift+b");
  });

  it("uses one unified, conflict-free default keymap", () => {
    expect(effectiveCombo("toggle-block-chrome", {})).toBe("shift+b");
    expect(effectiveCombo("toggle-text-blocks", {})).toBe("v");
    expect(effectiveCombo("stage-tool-select", {})).toBe("s");
    expect(effectiveCombo("stage-tool-block", {})).toBe("w");
    expect(effectiveCombo("stage-tool-hand", {})).toBe("h");
    expect(effectiveCombo("retouch-tool-brush", {})).toBe("b");
    expect(effectiveCombo("zoom-reset", {})).toBe("ctrl+0");

    const owners = new Map<string, string>();
    for (const action of SHORTCUT_ACTIONS) {
      for (const combo of effectiveCombosForAction(action.id, {})) {
        expect(owners.get(combo), `${combo} must have only one owner`).toBe(
          undefined,
        );
        owners.set(combo, action.id);
      }
    }
  });

  it("honors user overrides including explicit unbinding", () => {
    expect(
      effectiveCombo("toggle-block-chrome", {
        "toggle-block-chrome": "ctrl+b",
      }),
    ).toBe("ctrl+b");
    expect(
      effectiveCombo("toggle-block-chrome", { "toggle-block-chrome": "" }),
    ).toBe("");
  });

  it("builds a combo → action lookup that skips unbound actions", () => {
    const bindings = resolveBindings({ "translate-all": "" });
    expect(bindings.get("shift+b")).toBe("toggle-block-chrome");
    expect(bindings.get("v")).toBe("toggle-text-blocks");
    expect(bindings.get("b")).toBe("retouch-tool-brush");
    expect([...bindings.values()]).not.toContain("translate-all");
  });

  it("binds unified undo/redo to ctrl+z, ctrl+shift+z, and ctrl+y", () => {
    const bindings = resolveBindings({});
    expect(bindings.get("ctrl+z")).toBe("history-undo");
    expect(bindings.get("ctrl+shift+z")).toBe("history-redo");
    expect(bindings.get("ctrl+y")).toBe("history-redo");
  });

  it("binds workspace zoom to keyboard and ctrl-wheel defaults", () => {
    const bindings = resolveBindings({});
    expect(bindings.get("ctrl+=")).toBe("zoom-in");
    expect(bindings.get("ctrl+numpadadd")).toBe("zoom-in");
    expect(bindings.get("ctrl+wheelup")).toBe("zoom-in");
    expect(bindings.get("ctrl+-")).toBe("zoom-out");
    expect(bindings.get("ctrl+wheeldown")).toBe("zoom-out");
    expect(bindings.get("ctrl+0")).toBe("zoom-reset");
  });

  it("binds page and block navigation defaults and aliases", () => {
    const bindings = resolveBindings({});
    expect(bindings.get("pageup")).toBe("page-previous");
    expect(bindings.get("a")).toBe("page-previous");
    expect(bindings.get("arrowleft")).toBe("page-previous");
    expect(bindings.get("pagedown")).toBe("page-next");
    expect(bindings.get("d")).toBe("page-next");
    expect(bindings.get("arrowright")).toBe("page-next");
    expect(bindings.get("ctrl+shift+tab")).toBe("block-previous");
    expect(bindings.get("alt+arrowup")).toBe("block-previous");
    expect(bindings.get("ctrl+tab")).toBe("block-next");
    expect(bindings.get("alt+arrowdown")).toBe("block-next");
  });

  it("drops built-in page aliases after a user selects a different binding", () => {
    const bindings = resolveBindings({ "page-next": "n" });
    expect(bindings.get("n")).toBe("page-next");
    expect(bindings.has("pagedown")).toBe(false);
    expect(bindings.has("d")).toBe(false);
    expect(bindings.has("arrowright")).toBe(false);
  });

  it("keeps zoom-in numpad plus when the saved override matches its default", () => {
    const bindings = resolveBindings({ "zoom-in": "ctrl+=" });
    expect(bindings.get("ctrl+=")).toBe("zoom-in");
    expect(bindings.get("ctrl+numpadadd")).toBe("zoom-in");
  });

  it("rejects assigning another action's alternate combo without changing either action", () => {
    const overrides = {};
    const { next, conflictingActionId, conflictingLabel } = assignBinding(
      overrides,
      "toggle-text-blocks",
      "ctrl+numpadadd",
    );

    expect(next).toBe(overrides);
    expect(next["toggle-text-blocks"]).toBeUndefined();
    expect(next["zoom-in"]).toBeUndefined();
    expect(conflictingActionId).toBe("zoom-in");
    expect(conflictingLabel).toBe("이미지 확대");
  });

  it("rejects a primary-key conflict instead of silently unbinding its owner", () => {
    const overrides = {};
    const { next, conflictingActionId } = assignBinding(
      overrides,
      "toggle-text-blocks",
      "b",
    );
    expect(next).toBe(overrides);
    expect(next["toggle-text-blocks"]).toBeUndefined();
    expect(next["retouch-tool-brush"]).toBeUndefined();
    expect(conflictingActionId).toBe("retouch-tool-brush");
  });

  it("sanitizes legacy conflicts while allowing an explicitly cleared owner", () => {
    expect(
      sanitizeKeybindingOverrides({
        "toggle-text-blocks": "b",
      }),
    ).toEqual({});
    expect(
      sanitizeKeybindingOverrides({
        "retouch-tool-brush": "",
        "toggle-text-blocks": "b",
      }),
    ).toEqual({
      "retouch-tool-brush": "",
      "toggle-text-blocks": "b",
    });
  });

  it("resets a binding by dropping its override", () => {
    const reset = resetBinding(
      { "toggle-block-chrome": "ctrl+b" },
      "toggle-block-chrome",
    );
    expect(reset["toggle-block-chrome"]).toBeUndefined();
    expect(effectiveCombo("toggle-block-chrome", reset)).toBe("shift+b");
  });
});
