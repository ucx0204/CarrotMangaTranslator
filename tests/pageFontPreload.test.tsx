/** @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import {
  createPageFontLoadKeys,
  usePageFontPreload,
} from "../src/renderer/src/hooks/usePageFontPreload";
import { clearBlockFontLoadCache } from "../src/renderer/src/lib/blockFontLoading";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import type { MangaPage } from "../src/shared/libraryTypes";

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
const originalRequestIdleCallback = Object.getOwnPropertyDescriptor(
  window,
  "requestIdleCallback",
);
const originalCancelIdleCallback = Object.getOwnPropertyDescriptor(
  window,
  "cancelIdleCallback",
);
let load: ReturnType<typeof vi.fn>;

beforeEach(() => {
  load = vi.fn(async () => [{} as FontFace]);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load },
  });
});

afterEach(() => {
  cleanup();
  clearBlockFontLoadCache(document);
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
  restoreWindowProperty("requestIdleCallback", originalRequestIdleCallback);
  restoreWindowProperty("cancelIdleCallback", originalCancelIdleCallback);
});

describe("neighbor page font preload", () => {
  it("deduplicates identical page font sets", () => {
    expect(
      createPageFontLoadKeys(
        [makePage("page-1"), makePage("page-2")],
        DEFAULT_BLOCK_FONT_CATALOG,
      ),
    ).toHaveLength(1);
  });

  it("waits for catalog hydration and reuses settled face requests", async () => {
    const pages = [makePage("page-1"), makePage("page-2")];
    const view = render(<Harness pages={pages} ready={false} />);
    expect(load).not.toHaveBeenCalled();

    view.rerender(<Harness pages={pages} ready />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    view.rerender(<Harness pages={pages} ready />);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("loads the current page before scheduling neighbor fonts while idle", async () => {
    let idleCallback: IdleRequestCallback | null = null;
    let resolveCurrent: ((faces: FontFace[]) => void) | undefined;
    Object.defineProperties(window, {
      cancelIdleCallback: { configurable: true, value: vi.fn() },
      requestIdleCallback: {
        configurable: true,
        value: vi.fn((callback: IdleRequestCallback) => {
          idleCallback = callback;
          return 17;
        }),
      },
    });
    load.mockImplementation((css: string) => {
      if (css.includes("MGT Nanum Myeongjo")) {
        return new Promise<FontFace[]>((resolve) => {
          resolveCurrent = resolve;
        });
      }
      return Promise.resolve([{} as FontFace]);
    });

    render(
      <Harness
        pages={[
          makePage("page-1", "nanum-myeongjo"),
          makePage("page-2", "jua"),
        ]}
        ready
      />,
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(load.mock.calls[0]?.[0]).toContain("MGT Nanum Myeongjo");
    expect(idleCallback).toBeNull();

    act(() => resolveCurrent?.([{} as FontFace]));
    await waitFor(() => expect(idleCallback).not.toBeNull());
    expect(load).toHaveBeenCalledTimes(1);

    act(() => idleCallback?.({ didTimeout: false, timeRemaining: () => 50 }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(load.mock.calls[1]?.[0]).toContain("MGT Jua");
  });
});

function Harness({
  pages,
  ready,
}: {
  pages: MangaPage[];
  ready: boolean;
}): React.JSX.Element {
  return (
    <FontsContext.Provider
      value={{
        baseOptions: [],
        busy: false,
        catalog: DEFAULT_BLOCK_FONT_CATALOG,
        options: [],
        ready,
        registerFont: async () => undefined,
        removeFont: async () => undefined,
        savePreferences: async () => undefined,
      }}
    >
      <Preload pages={pages} />
    </FontsContext.Provider>
  );
}

function Preload({ pages }: { pages: MangaPage[] }): null {
  usePageFontPreload(pages[0] ?? null, pages.slice(1));
  return null;
}

function makePage(id: string, fontFamily?: string): MangaPage {
  return {
    analysisStatus: "completed",
    blocks: [
      {
        backgroundColor: "#ffffff",
        bbox: { h: 100, w: 100, x: 0, y: 0 },
        confidence: 1,
        fontSizePx: 24,
        fontFamily,
        id: `${id}-block`,
        lineHeight: 1.2,
        opacity: 1,
        renderDirection: "horizontal",
        sourceDirection: "horizontal",
        sourceText: "",
        textAlign: "center",
        textColor: "#111111",
        translatedText: "텍스트",
        type: "nonsolid",
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    dataUrl: "",
    height: 1000,
    id,
    imagePath: `${id}.png`,
    name: `${id}.png`,
    updatedAt: "2026-01-01T00:00:00.000Z",
    width: 1000,
  };
}

function restoreWindowProperty(
  property: "requestIdleCallback" | "cancelIdleCallback",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(window, property, descriptor);
  else Reflect.deleteProperty(window, property);
}
