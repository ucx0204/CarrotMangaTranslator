import { describe, expect, it } from "vitest";
import {
  comboFromEvent,
  formatCombo,
} from "../src/renderer/src/lib/shortcuts/comboFromEvent";
import {
  assignBinding,
  effectiveCombo,
  resetBinding,
  resolveBindings,
} from "../src/renderer/src/lib/shortcuts/shortcutActions";

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

describe("formatCombo", () => {
  it("renders display tokens", () => {
    expect(formatCombo("ctrl+shift+t")).toEqual(["Ctrl", "Shift", "T"]);
    expect(formatCombo("?")).toEqual(["?"]);
    expect(formatCombo("ctrl+,")).toEqual(["Ctrl", ","]);
    expect(formatCombo("ctrl+numpadadd")).toEqual(["Ctrl", "+"]);
    expect(formatCombo("delete")).toEqual(["Del"]);
    expect(formatCombo("")).toEqual([]);
  });
});

describe("shortcut binding resolution", () => {
  it("falls back to the built-in default combo", () => {
    expect(effectiveCombo("toggle-block-chrome", {})).toBe("b");
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
    expect(bindings.get("b")).toBe("toggle-block-chrome");
    expect([...bindings.values()]).not.toContain("translate-all");
  });

  it("binds chapter undo/redo to ctrl+z and ctrl+shift+z by default", () => {
    const bindings = resolveBindings({});
    expect(bindings.get("ctrl+z")).toBe("history-undo");
    expect(bindings.get("ctrl+shift+z")).toBe("history-redo");
  });

  it("binds workspace zoom to ctrl+= / ctrl+- / ctrl+0", () => {
    const bindings = resolveBindings({});
    expect(bindings.get("ctrl+=")).toBe("zoom-in");
    expect(bindings.get("ctrl+numpadadd")).toBe("zoom-in");
    expect(bindings.get("ctrl+-")).toBe("zoom-out");
    expect(bindings.get("ctrl+0")).toBe("zoom-reset");
  });

  it("keeps zoom-in numpad plus when the saved override matches its default", () => {
    const bindings = resolveBindings({ "zoom-in": "ctrl+=" });
    expect(bindings.get("ctrl+=")).toBe("zoom-in");
    expect(bindings.get("ctrl+numpadadd")).toBe("zoom-in");
  });

  it("displaces zoom-in when assigning its numpad plus alias elsewhere", () => {
    const { next, displacedLabel } = assignBinding(
      {},
      "toggle-text-blocks",
      "ctrl+numpadadd",
    );

    expect(next["toggle-text-blocks"]).toBe("ctrl+numpadadd");
    expect(next["zoom-in"]).toBe("");
    expect(displacedLabel).toBe("이미지 확대");
  });

  it("displaces a conflicting action when assigning a combo", () => {
    const { next, displacedLabel } = assignBinding(
      {},
      "toggle-text-blocks",
      "b",
    );
    expect(next["toggle-text-blocks"]).toBe("b");
    expect(next["toggle-block-chrome"]).toBe("");
    expect(displacedLabel).toBeTruthy();
  });

  it("resets a binding by dropping its override", () => {
    const reset = resetBinding(
      { "toggle-block-chrome": "ctrl+b" },
      "toggle-block-chrome",
    );
    expect(reset["toggle-block-chrome"]).toBeUndefined();
    expect(effectiveCombo("toggle-block-chrome", reset)).toBe("b");
  });
});
