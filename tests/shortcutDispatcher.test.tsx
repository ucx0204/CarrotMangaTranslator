/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useShortcutDispatcher,
  type ShortcutHoldHandlers,
  type ShortcutHandlers,
} from "../src/renderer/src/hooks/useShortcutDispatcher";
import { SHORTCUT_ACTIONS } from "../src/renderer/src/lib/shortcuts/shortcutActions";
import type { ShortcutContext } from "../src/renderer/src/lib/shortcuts/shortcutActionTypes";
import type { KeybindingOverrides } from "../src/shared/shortcutSettings";

afterEach(cleanup);

describe("customizable page and block shortcut dispatch", () => {
  it("dispatches letter shortcuts from their physical keys under a Korean IME", () => {
    const brush = vi.fn();
    const toggleChrome = vi.fn();
    const toggleBlocks = vi.fn();
    render(
      <ShortcutHarness
        handlers={{
          "retouch-tool-brush": brush,
          "toggle-block-chrome": toggleChrome,
          "toggle-text-blocks": toggleBlocks,
        }}
      />,
    );

    fireEvent.keyDown(document.body, { key: "ㅠ", code: "KeyB" });
    fireEvent.keyDown(document.body, {
      key: "ㅠ",
      code: "KeyB",
      shiftKey: true,
    });
    fireEvent.keyDown(document.body, { key: "ㅍ", code: "KeyV" });

    expect(brush).toHaveBeenCalledOnce();
    expect(toggleChrome).toHaveBeenCalledOnce();
    expect(toggleBlocks).toHaveBeenCalledOnce();
  });

  it("dispatches bare and modified numpad plus/minus as workspace zoom", () => {
    const zoomIn = vi.fn();
    const zoomOut = vi.fn();
    render(
      <ShortcutHarness handlers={{ "zoom-in": zoomIn, "zoom-out": zoomOut }} />,
    );

    const events = [
      new KeyboardEvent("keydown", {
        key: "+",
        code: "NumpadAdd",
        bubbles: true,
        cancelable: true,
      }),
      new KeyboardEvent("keydown", {
        key: "+",
        code: "NumpadAdd",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
      new KeyboardEvent("keydown", {
        key: "-",
        code: "NumpadSubtract",
        bubbles: true,
        cancelable: true,
      }),
      new KeyboardEvent("keydown", {
        key: "-",
        code: "NumpadSubtract",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ];
    for (const event of events) document.body.dispatchEvent(event);

    expect(zoomIn).toHaveBeenCalledTimes(2);
    expect(zoomOut).toHaveBeenCalledTimes(2);
    expect(events.every((event) => event.defaultPrevented)).toBe(true);
  });

  it("dispatches every assigned primary shortcut through the global listener", () => {
    for (const action of SHORTCUT_ACTIONS) {
      if (!action.defaultCombo) continue;
      const handler = vi.fn();
      const { unmount } = render(
        <ShortcutHarness
          contextOverrides={{ retouchToolActive: true }}
          handlers={{ [action.id]: handler }}
        />,
      );

      document.body.dispatchEvent(keyboardEventForCombo(action.defaultCombo));

      expect(
        handler,
        `${action.id} must dispatch from ${action.defaultCombo}`,
      ).toHaveBeenCalledOnce();
      unmount();
    }
  });

  it("dispatches a user binding for every registered action, including actions unassigned by default", () => {
    for (const action of SHORTCUT_ACTIONS) {
      const handler = vi.fn();
      const { unmount } = render(
        <ShortcutHarness
          contextOverrides={{ retouchToolActive: true }}
          handlers={{ [action.id]: handler }}
          jobActive={action.id === "cancel-job"}
          overrides={{ [action.id]: "f12" }}
        />,
      );

      fireEvent.keyDown(document.body, { key: "F12", code: "F12" });

      expect(
        handler,
        `${action.id} must dispatch from a user binding`,
      ).toHaveBeenCalledOnce();
      unmount();
    }
  });

  it("delivers Ctrl+Tab from a translation textarea and prevents native focus movement", () => {
    const blockNext = vi.fn();
    render(<ShortcutHarness handlers={{ "block-next": blockNext }} />);
    const textarea = screen.getByRole("textbox", { name: "번역" });
    textarea.focus();

    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);

    expect(blockNext).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(textarea);
  });

  it("receives global shortcuts before a focused control stops bubbling", () => {
    const commandPalette = vi.fn();
    render(
      <ShortcutHarness
        handlers={{ "toggle-command-palette": commandPalette }}
      />,
    );
    const textarea = screen.getByRole("textbox", { name: "번역" });
    const targetKeyDown = vi.fn((event: KeyboardEvent) =>
      event.stopPropagation(),
    );
    textarea.addEventListener("keydown", targetKeyDown);

    fireEvent.keyDown(textarea, { key: "k", code: "KeyK", ctrlKey: true });

    expect(commandPalette).toHaveBeenCalledOnce();
    expect(targetKeyDown).not.toHaveBeenCalled();
  });

  it("lets Ctrl+H close the consistency editor it opened", () => {
    const toggleConsistencyEditor = vi.fn();
    render(
      <ShortcutHarness
        contextOverrides={{
          blockingModalOpen: true,
          activeModalActionId: "open-search-replace",
        }}
        handlers={{ "open-search-replace": toggleConsistencyEditor }}
      />,
    );

    fireEvent.keyDown(document.body, {
      key: "h",
      code: "KeyH",
      ctrlKey: true,
    });

    expect(toggleConsistencyEditor).toHaveBeenCalledOnce();
  });

  it("does not open the consistency editor behind gather text", () => {
    const openConsistencyEditor = vi.fn();
    render(
      <ShortcutHarness
        contextOverrides={{
          blockingModalOpen: true,
          activeModalActionId: "gather-text",
        }}
        handlers={{ "open-search-replace": openConsistencyEditor }}
      />,
    );

    fireEvent.keyDown(document.body, {
      key: "h",
      code: "KeyH",
      ctrlKey: true,
    });

    expect(openConsistencyEditor).not.toHaveBeenCalled();
  });

  it("does not open the consistency editor behind an unrelated blocking modal", () => {
    const toggleConsistencyEditor = vi.fn();
    render(
      <ShortcutHarness
        contextOverrides={{ blockingModalOpen: true }}
        handlers={{ "open-search-replace": toggleConsistencyEditor }}
      />,
    );

    fireEvent.keyDown(document.body, {
      key: "h",
      code: "KeyH",
      ctrlKey: true,
    });

    expect(toggleConsistencyEditor).not.toHaveBeenCalled();
  });

  it("allows each shortcut-owned modal to close itself and blocks every other action", () => {
    const modalActions = [
      "open-settings",
      "open-translate-options",
      "gather-text",
      "toggle-inpainting",
      "open-export-options",
      "open-search-replace",
    ] as const;
    for (const activeModalActionId of modalActions) {
      const closeActiveModal = vi.fn();
      const unrelatedAction = vi.fn();
      const { unmount } = render(
        <ShortcutHarness
          contextOverrides={{ blockingModalOpen: true, activeModalActionId }}
          handlers={{
            [activeModalActionId]: closeActiveModal,
            "toggle-text-blocks": unrelatedAction,
          }}
          overrides={{ [activeModalActionId]: "f12" }}
        />,
      );

      fireEvent.keyDown(document.body, { key: "F12", code: "F12" });
      fireEvent.keyDown(document.body, { key: "v", code: "KeyV" });

      expect(
        closeActiveModal,
        `${activeModalActionId} must close its own modal`,
      ).toHaveBeenCalledOnce();
      expect(unrelatedAction).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("keeps modifier-based editor commands available in focused text fields", () => {
    const searchReplace = vi.fn();
    const exportOptions = vi.fn();
    const settings = vi.fn();
    render(
      <ShortcutHarness
        handlers={{
          "open-search-replace": searchReplace,
          "open-export-options": exportOptions,
          "open-settings": settings,
        }}
      />,
    );
    const textarea = screen.getByRole("textbox", { name: "번역" });

    fireEvent.keyDown(textarea, { key: "h", code: "KeyH", ctrlKey: true });
    fireEvent.keyDown(textarea, { key: "e", code: "KeyE", ctrlKey: true });
    fireEvent.keyDown(textarea, { key: ",", code: "Comma", ctrlKey: true });

    expect(searchReplace).toHaveBeenCalledOnce();
    expect(exportOptions).toHaveBeenCalledOnce();
    expect(settings).toHaveBeenCalledOnce();
  });

  it("only permits the matching close actions while palette and help overlays are open", () => {
    const palette = vi.fn();
    const help = vi.fn();
    const blocks = vi.fn();
    const paletteRender = render(
      <ShortcutHarness
        contextOverrides={{ paletteOpen: true }}
        handlers={{
          "toggle-command-palette": palette,
          "toggle-shortcut-help": help,
          "toggle-text-blocks": blocks,
        }}
      />,
    );

    fireEvent.keyDown(document.body, {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
    });
    fireEvent.keyDown(document.body, {
      key: "?",
      code: "Slash",
      shiftKey: true,
    });
    fireEvent.keyDown(document.body, { key: "v", code: "KeyV" });
    expect(palette).toHaveBeenCalledOnce();
    expect(help).not.toHaveBeenCalled();
    expect(blocks).not.toHaveBeenCalled();
    paletteRender.unmount();

    render(
      <ShortcutHarness
        contextOverrides={{ helpOpen: true }}
        handlers={{
          "toggle-command-palette": palette,
          "toggle-shortcut-help": help,
          "toggle-text-blocks": blocks,
        }}
      />,
    );
    fireEvent.keyDown(document.body, {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
    });
    fireEvent.keyDown(document.body, {
      key: "?",
      code: "Slash",
      shiftKey: true,
    });
    fireEvent.keyDown(document.body, { key: "v", code: "KeyV" });
    expect(palette).toHaveBeenCalledTimes(2);
    expect(help).toHaveBeenCalledOnce();
    expect(blocks).not.toHaveBeenCalled();
  });

  it("allows both block directions in editable fields but blocks page navigation", () => {
    const blockPrevious = vi.fn();
    const pagePrevious = vi.fn();
    render(
      <ShortcutHarness
        handlers={{
          "block-previous": blockPrevious,
          "page-previous": pagePrevious,
        }}
      />,
    );
    const textarea = screen.getByRole("textbox", { name: "번역" });

    fireEvent.keyDown(textarea, { key: "Tab", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(textarea, { key: "PageUp" });
    expect(blockPrevious).toHaveBeenCalledOnce();
    expect(pagePrevious).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "PageUp" });
    expect(pagePrevious).toHaveBeenCalledOnce();
  });

  it("leaves unmodified navigation keys to focused ARIA controls", () => {
    const pagePrevious = vi.fn();
    const pageNext = vi.fn();
    render(
      <ShortcutHarness
        handlers={{
          "page-previous": pagePrevious,
          "page-next": pageNext,
        }}
      />,
    );
    const tab = screen.getByRole("tab");

    fireEvent.keyDown(tab, { key: "ArrowLeft", code: "ArrowLeft" });
    fireEvent.keyDown(tab, { key: "ArrowRight", code: "ArrowRight" });

    expect(pagePrevious).not.toHaveBeenCalled();
    expect(pageNext).not.toHaveBeenCalled();
  });

  it("uses a custom page binding without retaining its built-in aliases", () => {
    const pageNext = vi.fn();
    render(
      <ShortcutHarness
        handlers={{ "page-next": pageNext }}
        overrides={{ "page-next": "n" }}
      />,
    );

    fireEvent.keyDown(document.body, { key: "PageDown" });
    fireEvent.keyDown(document.body, { key: "d" });
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(pageNext).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "n" });
    expect(pageNext).toHaveBeenCalledOnce();
  });

  it("allows editing a completed page while another page job is active", () => {
    const deleteBlock = vi.fn();
    const translatePending = vi.fn();
    render(
      <ShortcutHarness
        jobActive
        handlers={{
          "delete-block": deleteBlock,
          "translate-pending": translatePending,
        }}
      />,
    );

    fireEvent.keyDown(document.body, { key: "Delete" });
    fireEvent.keyDown(document.body, { key: "T", shiftKey: true });

    expect(deleteBlock).toHaveBeenCalledOnce();
    expect(translatePending).not.toHaveBeenCalled();
  });

  it("treats the customized hand shortcut as a press-and-hold action", () => {
    const onPress = vi.fn();
    const onRelease = vi.fn();
    render(
      <ShortcutHarness
        handlers={{ "stage-tool-hand": vi.fn() }}
        holdHandlers={{ "stage-tool-hand": { onPress, onRelease } }}
        overrides={{ "stage-tool-hand": "f12" }}
      />,
    );

    fireEvent.keyDown(document.body, { key: "F12", code: "F12" });
    fireEvent.keyDown(document.body, {
      key: "F12",
      code: "F12",
      repeat: true,
    });
    expect(onPress).toHaveBeenCalledOnce();
    expect(onRelease).not.toHaveBeenCalled();

    fireEvent.keyUp(document.body, { key: "F12", code: "F12" });
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it("does not start the temporary hand tool in an editor or during IME composition", () => {
    const onPress = vi.fn();
    render(
      <ShortcutHarness
        handlers={{}}
        holdHandlers={{
          "stage-tool-hand": { onPress, onRelease: vi.fn() },
        }}
      />,
    );
    const textarea = screen.getByRole("textbox", { name: "번역" });

    fireEvent.keyDown(textarea, { key: "h", code: "KeyH" });
    fireEvent.keyDown(document.body, {
      key: "h",
      code: "KeyH",
      isComposing: true,
    });
    expect(onPress).not.toHaveBeenCalled();
  });
});

function ShortcutHarness({
  handlers,
  holdHandlers = {},
  jobActive = false,
  overrides = {},
  contextOverrides = {},
}: {
  handlers: ShortcutHandlers;
  holdHandlers?: ShortcutHoldHandlers;
  jobActive?: boolean;
  overrides?: KeybindingOverrides;
  contextOverrides?: Partial<ShortcutContext>;
}): React.JSX.Element {
  useShortcutDispatcher({
    context: {
      blockingModalOpen: false,
      activeModalActionId: null,
      paletteOpen: false,
      helpOpen: false,
      chapterOpen: true,
      editLocked: false,
      jobActive,
      retouchToolActive: false,
      blockSelected: true,
      ...contextOverrides,
    },
    handlers,
    holdHandlers,
    overrides,
  });
  return (
    <>
      <textarea aria-label="번역" />
      <button role="tab">서식</button>
    </>
  );
}

function keyboardEventForCombo(combo: string): KeyboardEvent {
  const tokens = combo.split("+");
  const main = tokens.at(-1) ?? "";
  const keyNames: Record<string, string> = {
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    arrowup: "ArrowUp",
    delete: "Delete",
    pagedown: "PageDown",
    pageup: "PageUp",
    tab: "Tab",
  };
  const isLetter = /^[a-z]$/.test(main);
  const isDigit = /^\d$/.test(main);
  return new KeyboardEvent("keydown", {
    key: keyNames[main] ?? main,
    code: isLetter
      ? `Key${main.toUpperCase()}`
      : isDigit
        ? `Digit${main}`
        : undefined,
    ctrlKey: tokens.includes("ctrl"),
    altKey: tokens.includes("alt"),
    shiftKey: tokens.includes("shift"),
    bubbles: true,
    cancelable: true,
  });
}
