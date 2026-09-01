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
import { useTranslation } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiLocale } from "../src/shared/uiLocales";
import { appI18n, initializeAppI18n } from "../src/renderer/src/appI18n";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { useAppSessionCoreState } from "../src/renderer/src/app/session/useAppSessionCoreState";
import { FontsProvider } from "../src/renderer/src/fonts/FontsProvider";
import { useFonts } from "../src/renderer/src/fonts/useFonts";
import { AppI18nProvider } from "../src/renderer/src/i18n";
import { useStatusLog } from "../src/renderer/src/hooks/useStatusLog";
import {
  DEFAULT_BLOCK_FONT_CATALOG,
  getBlockFontOptions,
  resolveBlockFontOption,
} from "../src/renderer/src/lib/fonts";

let localeListener: ((locale: UiLocale) => void) | null = null;

afterEach(async () => {
  cleanup();
  localeListener = null;
  await appI18n.changeLanguage("ko");
  window.location.hash = "";
  document.getElementById("mgt-custom-fonts")?.remove();
});

describe("renderer UI locale runtime", () => {
  it("updates every subscribed window immediately after a locale event", async () => {
    window.mangaApi = createTestMangaGatewayStub({
      onUiLocaleChanged: (callback: (locale: UiLocale) => void) => {
        localeListener = callback;
        return () => {
          localeListener = null;
        };
      },
    });
    await initializeAppI18n("en");
    render(
      <AppI18nProvider>
        <span>{appI18n.t("app.title", { ns: "common" })}</span>
      </AppI18nProvider>,
    );
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("Carrot Manga Translator");

    act(() => localeListener?.("zh-Hant"));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe("zh-Hant");
      expect(document.title).toBe("胡蘿蔔漫畫翻譯器");
    });
  });

  it("uses the localized editor title in a detached panel window", async () => {
    window.location.hash = "#panel=editor";
    window.mangaApi = createTestMangaGatewayStub({
      onUiLocaleChanged: (callback: (locale: UiLocale) => void) => {
        localeListener = callback;
        return () => {
          localeListener = null;
        };
      },
    });
    await initializeAppI18n("ja");
    render(<AppI18nProvider>panel</AppI18nProvider>);
    await waitFor(() => expect(document.title).toBe("ブロック編集"));
  });

  it("keeps the status log but drops re-derivable transient state when the locale changes", async () => {
    window.mangaApi = createTestMangaGatewayStub({
      onUiLocaleChanged: (callback: (locale: UiLocale) => void) => {
        localeListener = callback;
        return () => {
          localeListener = null;
        };
      },
      writeLog: vi.fn().mockResolvedValue(undefined),
    });
    await initializeAppI18n("en");
    render(
      <AppI18nProvider>
        <TransientStateHarness />
      </AppI18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "seed" }));
    expect(screen.getByTestId("status").textContent).toContain(
      "Settings saved",
    );
    expect(screen.getByTestId("detail").textContent).toBe("Old English detail");

    act(() => localeListener?.("ja"));
    await waitFor(() => {
      expect(screen.getByTestId("detail").textContent).toBe("");
      expect(screen.getByTestId("progress").textContent).toBe(
        appI18n.t("job.phase.booting", { ns: "renderer" }),
      );
    });
    // The log is a record of what happened; re-translating past lines is
    // impossible, and discarding them would lose the account of a failure.
    expect(screen.getByTestId("status").textContent).toContain(
      "Settings saved",
    );
  });

  it("preserves translated transient state for a repeated locale event", async () => {
    window.mangaApi = createTestMangaGatewayStub({
      onUiLocaleChanged: (callback: (locale: UiLocale) => void) => {
        localeListener = callback;
        return () => {
          localeListener = null;
        };
      },
      writeLog: vi.fn().mockResolvedValue(undefined),
    });
    await initializeAppI18n("en");
    render(
      <AppI18nProvider>
        <TransientStateHarness />
      </AppI18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "seed" }));
    act(() => localeListener?.("en"));

    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toContain(
        "Settings saved",
      );
      expect(screen.getByTestId("progress").textContent).toBe(
        "Old English progress",
      );
      expect(screen.getByTestId("detail").textContent).toBe(
        "Old English detail",
      );
    });
  });

  it("uses localized metadata for the selected default font", async () => {
    await initializeAppI18n("en");
    const options = getBlockFontOptions(
      DEFAULT_BLOCK_FONT_CATALOG,
      appI18n.getFixedT("en", "renderer"),
    );
    expect(resolveBlockFontOption(undefined, options)).toMatchObject({
      label: "Default",
      sample: "Abc 가나다",
    });
  });

  it("reprioritizes bundled fonts immediately after a locale event", async () => {
    window.mangaApi = createTestMangaGatewayStub({
      getFontLibrary: vi.fn().mockResolvedValue({
        customFonts: [],
        preferences: {
          hiddenIds: [],
          favoriteIds: [],
          orderedIds: [],
          defaultFontId: "default",
        },
      }),
      onFontLibraryChanged: () => () => undefined,
      onUiLocaleChanged: (callback: (locale: UiLocale) => void) => {
        localeListener = callback;
        return () => {
          localeListener = null;
        };
      },
    });
    await initializeAppI18n("en");
    render(
      <AppI18nProvider>
        <FontsProvider>
          <FontOrderHarness />
        </FontsProvider>
      </AppI18nProvider>,
    );

    expect(screen.getByTestId("font-order").textContent).toBe(
      "default,comic-neue",
    );

    act(() => localeListener?.("zh-Hant"));
    await waitFor(() => {
      expect(screen.getByTestId("font-order").textContent).toBe(
        "default,huninn",
      );
    });
  });
});

function FontOrderHarness(): React.JSX.Element {
  const { options } = useFonts();
  return (
    <output data-testid="font-order">
      {options
        .slice(0, 2)
        .map((option) => option.id)
        .join(",")}
    </output>
  );
}

function TransientStateHarness(): React.JSX.Element {
  const { t } = useTranslation("renderer");
  const { statusLines, pushStatus } = useStatusLog();
  const { jobState, setJobState } = useAppSessionCoreState();
  return (
    <>
      <button
        onClick={() => {
          pushStatus(t("settings.saved"));
          setJobState((current) => ({
            ...current,
            status: "running",
            phase: "booting",
            progressText: "Old English progress",
            detail: "Old English detail",
          }));
        }}
      >
        seed
      </button>
      <output data-testid="status">{statusLines.join("|")}</output>
      <output data-testid="progress">{jobState.progressText}</output>
      <output data-testid="detail">{jobState.detail}</output>
    </>
  );
}
