/** @vitest-environment jsdom */

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

  it("marks the bundled catalog ready when initial hydration fails", async () => {
    const failure = new Error("font library unavailable");
    const fontSource = createFontSource(
      makeSnapshot("11111111-1111-4111-8111-111111111111", "Unused Family"),
    );
    const source: FontLibrarySource = {
      ...fontSource.source,
      getFontLibrary: vi.fn(async () => Promise.reject(failure)),
    };
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      render(
        <FontsProvider source={source}>
          <FontReadinessConsumer />
        </FontsProvider>,
      );
      expect(screen.getByTestId("font-readiness").textContent).toBe("loading");
      await waitFor(() =>
        expect(screen.getByTestId("font-readiness").textContent).toBe("ready"),
      );
      expect(consoleError).toHaveBeenCalledWith(failure);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("refreshes the catalog after successful font actions", async () => {
    const snapshot = makeSnapshot(
      "11111111-1111-4111-8111-111111111111",
      "Action Family",
    );
    const fontSource = createFontSource(snapshot);
    const getFontLibrary = vi.fn(fontSource.source.getFontLibrary);
    const registerCustomFont = vi.fn(
      async () => snapshot.customFonts[0] ?? null,
    );
    const removeCustomFont = vi.fn(async () => snapshot.customFonts);
    const saveFontPreferences = vi.fn(
      async (preferences: FontPreferences): Promise<FontLibrarySnapshot> => ({
        ...snapshot,
        preferences,
      }),
    );
    const source: FontLibrarySource = {
      ...fontSource.source,
      getFontLibrary,
      registerCustomFont,
      removeCustomFont,
      saveFontPreferences,
    };

    render(
      <FontsProvider source={source}>
        <FontActionsConsumer />
      </FontsProvider>,
    );
    await waitFor(() => expect(getFontLibrary).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "register" }));
    await waitFor(() => {
      expect(registerCustomFont).toHaveBeenCalledTimes(1);
      expect(getFontLibrary).toHaveBeenCalledTimes(2);
    });
    fireEvent.click(screen.getByRole("button", { name: "remove" }));
    await waitFor(() => {
      expect(removeCustomFont).toHaveBeenCalledWith(
        snapshot.customFonts[0]?.id,
      );
      expect(getFontLibrary).toHaveBeenCalledTimes(3);
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(saveFontPreferences).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("font-busy").textContent).toBe("idle");
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

function FontReadinessConsumer(): React.JSX.Element {
  const { ready } = useFonts();
  return (
    <output data-testid="font-readiness">
      {ready === false ? "loading" : "ready"}
    </output>
  );
}

function FontActionsConsumer(): React.JSX.Element {
  const { busy, catalog, registerFont, removeFont, savePreferences } =
    useFonts();
  const fontId = catalog.customFonts[0]?.id ?? "missing";
  return (
    <>
      <output data-testid="font-busy">{busy ? "busy" : "idle"}</output>
      <button type="button" onClick={() => void registerFont()}>
        register
      </button>
      <button type="button" onClick={() => void removeFont(fontId)}>
        remove
      </button>
      <button
        type="button"
        onClick={() =>
          void savePreferences({
            defaultFontId: fontId,
            favoriteIds: [],
            orderedIds: [],
          })
        }
      >
        save
      </button>
    </>
  );
}

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
