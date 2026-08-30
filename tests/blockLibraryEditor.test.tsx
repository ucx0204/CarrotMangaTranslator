/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  BlockLibraryEntryV1,
  BlockLibrarySnapshotV1,
} from "../src/shared/blockLibrary";
import { BlockLibraryCard } from "../src/renderer/src/components/BlockLibraryCard";
import { EditBlockLibraryModal } from "../src/renderer/src/components/EditBlockLibraryModal";
import type { BlockLibrarySource } from "../src/renderer/src/components/blockLibraryModel";
import {
  readStoredEditorTab,
  storeEditorTab,
} from "../src/renderer/src/components/editorPanelUtils";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalResizeObserver = globalThis.ResizeObserver;

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      font: "",
      measureText: (text: string) => ({ width: Array.from(text).length * 10 }),
    }),
  });
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

afterEach(cleanup);

afterAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: originalGetContext,
  });
  globalThis.ResizeObserver = originalResizeObserver;
});

describe("block library editor", () => {
  it("routes card actions and reflects insert, busy, and missing-font states", () => {
    const entry = makeEntry();
    const onDelete = vi.fn();
    const onEdit = vi.fn();
    const onInsert = vi.fn();
    const { container, rerender } = render(
      <BlockLibraryCard
        busy={false}
        canInsert
        entry={entry}
        fontCatalog={DEFAULT_BLOCK_FONT_CATALOG}
        missingFont={false}
        onDelete={onDelete}
        onEdit={onEdit}
        onInsert={onInsert}
      />,
    );

    const insertButton = screen.getByRole("button", { name: entry.name });
    expect((insertButton as HTMLButtonElement).disabled).toBe(false);
    expect(container.querySelector(".page-artwork")).toBeTruthy();
    expect(screen.queryByText("글꼴 없음 · 대체 글꼴로 미리보기")).toBeNull();

    fireEvent.click(insertButton);
    fireEvent.click(screen.getByRole("button", { name: "블록 편집" }));
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    expect(onInsert).toHaveBeenCalledOnce();
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledOnce();

    rerender(
      <BlockLibraryCard
        busy={false}
        canInsert={false}
        entry={entry}
        fontCatalog={DEFAULT_BLOCK_FONT_CATALOG}
        missingFont
        onDelete={onDelete}
        onEdit={onEdit}
        onInsert={onInsert}
      />,
    );
    expect(
      (
        screen.getByRole("button", {
          name: /쾅.*글꼴 없음 · 대체 글꼴로 미리보기/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("글꼴 없음 · 대체 글꼴로 미리보기")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "블록 편집" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    rerender(
      <BlockLibraryCard
        busy
        canInsert
        entry={entry}
        fontCatalog={DEFAULT_BLOCK_FONT_CATALOG}
        missingFont={false}
        onDelete={onDelete}
        onEdit={onEdit}
        onInsert={onInsert}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "블록 편집" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "삭제" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("reuses the block editor with a live fitted preview and updates the template", async () => {
    const entry = makeEntry();
    const updateBlockLibraryEntry = vi.fn(async (input) => ({
      schemaVersion: 1 as const,
      entries: [
        {
          ...entry,
          name: input.name,
          block: input.block,
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    }));
    const source = makeSource(updateBlockLibraryEntry);
    const onUpdated = vi.fn();
    const { container } = render(
      <FontsContext.Provider value={FONT_CONTEXT_VALUE}>
        <EditBlockLibraryModal
          entry={entry}
          source={source}
          onClose={vi.fn()}
          onUpdated={onUpdated}
        />
      </FontsContext.Provider>,
    );

    expect(screen.getByRole("tab", { name: "텍스트" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "배치" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "서식" })).toBeTruthy();
    expect(container.querySelector(".page-artwork")).toBeTruthy();
    expect(
      container.querySelector<HTMLElement>(".page-artwork")?.parentElement
        ?.style.transform,
    ).toContain("scale(2.866");

    fireEvent.change(screen.getByLabelText("이름"), {
      target: { value: " 새 의성어 " },
    });
    fireEvent.click(screen.getByRole("tab", { name: "서식" }));
    fireEvent.click(screen.getByRole("button", { name: "블록 전체 굵게" }));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(updateBlockLibraryEntry).toHaveBeenCalledOnce());
    expect(updateBlockLibraryEntry.mock.calls[0]?.[0]).toMatchObject({
      id: entry.id,
      name: "새 의성어",
      block: {
        bold: true,
        translatedText: "쾅!",
        size: { w: 300, h: 200 },
      },
    });
    expect(updateBlockLibraryEntry.mock.calls[0]?.[0].block).not.toHaveProperty(
      "bbox",
    );
    expect(onUpdated).toHaveBeenCalledOnce();
  });

  it("keeps page-only position fields out while exposing size and transforms", () => {
    render(
      <FontsContext.Provider value={FONT_CONTEXT_VALUE}>
        <EditBlockLibraryModal
          entry={makeEntry()}
          source={makeSource(vi.fn())}
          onClose={vi.fn()}
          onUpdated={vi.fn()}
        />
      </FontsContext.Provider>,
    );

    fireEvent.click(screen.getByRole("tab", { name: "배치" }));
    expect(screen.queryByRole("spinbutton", { name: "X" })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: "Y" })).toBeNull();
    expect(screen.getByRole("spinbutton", { name: "너비" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "높이" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "원근" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "곡선" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "워프" })).toBeTruthy();
  });

  it("falls back safely when editor tab storage is unavailable", () => {
    const originalStorage = window.localStorage;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("read blocked");
        },
        setItem: () => {
          throw new Error("write blocked");
        },
      },
    });
    try {
      expect(readStoredEditorTab()).toBe("text");
      expect(() => storeEditorTab("format")).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: originalStorage,
      });
      warn.mockRestore();
    }
  });
});

const FONT_CONTEXT_VALUE = {
  busy: false,
  catalog: DEFAULT_BLOCK_FONT_CATALOG,
  baseOptions: [],
  options: [
    {
      id: "default",
      label: "기본",
      cssFamily: "sans-serif",
      sample: "가나다 Aa",
    },
  ],
  registerFont: async () => undefined,
  removeFont: async () => undefined,
  savePreferences: async () => undefined,
};

function makeSource(
  updateBlockLibraryEntry: BlockLibrarySource["updateBlockLibraryEntry"],
): BlockLibrarySource {
  const snapshot: BlockLibrarySnapshotV1 = {
    schemaVersion: 1,
    entries: [],
  };
  return {
    deleteBlockLibraryEntry: vi.fn(async () => snapshot),
    listBlockLibraryEntries: vi.fn(async () => snapshot),
    renameBlockLibraryEntry: vi.fn(async () => snapshot),
    saveBlockLibraryEntry: vi.fn(async () => snapshot),
    updateBlockLibraryEntry,
    useBlockLibraryEntry: vi.fn(async () => makeEntry()),
  };
}

function makeEntry(): BlockLibraryEntryV1 {
  return {
    schemaVersion: 1,
    id: "entry-1",
    name: "쾅",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    block: {
      sourceText: "ドン!",
      translatedText: "쾅!",
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 48,
      lineHeight: 1.2,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fff2c7",
      opacity: 0.7,
      size: { w: 300, h: 200 },
    },
  };
}
