/** @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FontLibrarySnapshot,
  FontPreferences,
} from "../src/shared/libraryTypes";
import {
  FontsProvider,
  type FontLibrarySource,
} from "../src/renderer/src/fonts/FontsProvider";
import { useFonts } from "../src/renderer/src/fonts/useFonts";
import { resolveBlockFontFamily } from "../src/renderer/src/lib/fonts";

afterEach(cleanup);

describe("FontsProvider catalog isolation", () => {
  it("keeps providers isolated and rerenders only subscribers to an updated catalog", async () => {
    const first = createFontSource(
      makeSnapshot("11111111-1111-4111-8111-111111111111", "First Family"),
    );
    const second = createFontSource(
      makeSnapshot("22222222-2222-4222-8222-222222222222", "Second Family"),
    );
    const firstRender = vi.fn();
    const secondRender = vi.fn();

    render(
      <>
        <FontsProvider source={first.source}>
          <FontCatalogConsumer id="first" onRender={firstRender} />
        </FontsProvider>
        <FontsProvider source={second.source}>
          <FontCatalogConsumer id="second" onRender={secondRender} />
        </FontsProvider>
      </>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("first").textContent).toBe("First Family");
      expect(screen.getByTestId("second").textContent).toBe("Second Family");
    });
    expect(screen.getByTestId("first").style.fontFamily).toContain(
      "First Family",
    );
    expect(screen.getByTestId("second").style.fontFamily).toContain(
      "Second Family",
    );
    const secondRenderCount = secondRender.mock.calls.length;

    act(() => {
      first.emit(
        makeSnapshot(
          "33333333-3333-4333-8333-333333333333",
          "Updated First Family",
        ),
      );
    });

    expect(screen.getByTestId("first").textContent).toBe(
      "Updated First Family",
    );
    expect(screen.getByTestId("first").style.fontFamily).toContain(
      "Updated First Family",
    );
    expect(screen.getByTestId("second").textContent).toBe("Second Family");
    expect(secondRender).toHaveBeenCalledTimes(secondRenderCount);
    expect(firstRender.mock.calls.length).toBeGreaterThan(secondRenderCount);
  });

  it("keeps the context value stable across unrelated parent rerenders", async () => {
    const fontSource = createFontSource(
      makeSnapshot("11111111-1111-4111-8111-111111111111", "Stable Family"),
    );
    const renderCount = vi.fn();
    const view = render(
      <FontsProvider source={fontSource.source}>
        <MemoFontCatalogConsumer id="stable" onRender={renderCount} />
      </FontsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("stable").textContent).toBe("Stable Family");
    });
    const settledRenderCount = renderCount.mock.calls.length;

    view.rerender(
      <FontsProvider source={fontSource.source}>
        <MemoFontCatalogConsumer id="stable" onRender={renderCount} />
      </FontsProvider>,
    );

    expect(renderCount).toHaveBeenCalledTimes(settledRenderCount);
  });
});

function FontCatalogConsumer({
  id,
  onRender,
}: {
  id: string;
  onRender: () => void;
}): React.JSX.Element {
  const { catalog } = useFonts();
  onRender();
  return (
    <output
      data-testid={id}
      style={{ fontFamily: resolveBlockFontFamily(undefined, catalog) }}
    >
      {catalog.customFonts[0]?.label ?? "none"}
    </output>
  );
}

const MemoFontCatalogConsumer = React.memo(FontCatalogConsumer);

function createFontSource(initial: FontLibrarySnapshot): {
  source: FontLibrarySource;
  emit: (snapshot: FontLibrarySnapshot) => void;
} {
  let current = initial;
  let listener: ((snapshot: FontLibrarySnapshot) => void) | null = null;
  return {
    source: {
      getFontLibrary: async () => current,
      onFontLibraryChanged: (callback) => {
        listener = callback;
        return () => {
          listener = null;
        };
      },
      registerCustomFont: async () => null,
      removeCustomFont: async () => [],
      saveFontPreferences: async (preferences: FontPreferences) => {
        current = { ...current, preferences };
        return current;
      },
    },
    emit: (snapshot) => {
      current = snapshot;
      listener?.(snapshot);
    },
  };
}

function makeSnapshot(id: string, family: string): FontLibrarySnapshot {
  return {
    customFonts: [
      {
        id,
        family,
        label: family,
        fileName: `${id}.otf`,
      },
    ],
    preferences: {
      favoriteIds: [],
      orderedIds: [],
      defaultFontId: id,
    },
  };
}
