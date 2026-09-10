// @vitest-environment jsdom
import React from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_I18N_RESOURCES } from "../src/shared/i18n/resources";
import { SUPPORTED_UI_LOCALES, type UiLocale } from "../src/shared/uiLocales";
import {
  DEFAULT_REDACTION_PREFERENCES,
  DEFAULT_REDACTION_VIEW,
  type RedactionWorkspace,
} from "../src/shared/imageRedactionWorkspace";
import { useRedactionWorkspace } from "../src/renderer/src/components/imageRedaction/useRedactionWorkspace";
import { RedactionWorkspaceHeader } from "../src/renderer/src/components/imageRedaction/RedactionWorkspaceHeader";

afterEach(cleanup);

function fixture(): RedactionWorkspace {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    revision: 0,
    pages: [
      {
        id: "page-1",
        name: "001.png",
        imagePath: "fixture.png",
        fingerprint: "a".repeat(64),
        width: 1200,
        height: 1800,
        strokes: [],
        decision: "unreviewed",
      },
    ],
    view: {
      ...DEFAULT_REDACTION_VIEW,
      currentId: "page-1",
      selectedIds: ["page-1"],
    },
    preferences: { ...DEFAULT_REDACTION_PREFERENCES },
    presets: [],
  };
}

function HeaderHarness({
  preparation,
  onHelp,
}: {
  preparation: boolean;
  onHelp: () => void;
}) {
  const [workspace] = React.useState(fixture);
  const form = useRedactionWorkspace(workspace);
  return (
    <RedactionWorkspaceHeader
      form={form}
      preparation={preparation}
      onPresets={vi.fn()}
      onPreviousMask={vi.fn()}
      onExit={vi.fn()}
      onHelp={onHelp}
    />
  );
}

async function showHeader(locale: UiLocale, preparation: boolean) {
  const i18n = createInstance();
  await i18n.init({
    lng: locale,
    fallbackLng: false,
    defaultNS: "components",
    resources: { [locale]: APP_I18N_RESOURCES[locale] },
    interpolation: { escapeValue: false },
  });
  const onHelp = vi.fn();
  const result = render(
    <I18nextProvider i18n={i18n}>
      <HeaderHarness preparation={preparation} onHelp={onHelp} />
    </I18nextProvider>,
  );
  return {
    ...result,
    onHelp,
    text: APP_I18N_RESOURCES[locale].components.manualRedaction,
  };
}

describe("compact manual-redaction help", () => {
  for (const preparation of [false, true]) {
    it.each(SUPPORTED_UI_LOCALES)(
      `links mode-specific guidance to the info control in %s (preparation=${preparation})`,
      async (locale) => {
        const { text, container, onHelp } = await showHeader(
          locale,
          preparation,
        );
        const info = screen.getByRole("button", { name: text.about });
        const descriptionId = info.getAttribute("aria-describedby");
        expect(descriptionId).toBeTruthy();
        const tooltip = document.getElementById(descriptionId ?? "");
        expect(tooltip?.getAttribute("role")).toBe("tooltip");
        expect(tooltip?.textContent).toBe(
          preparation ? text.preparationHint : text.outboundHint,
        );
        expect(info.getAttribute("title")).toBeNull();
        expect(container.querySelectorAll("p")).toHaveLength(0);
        fireEvent.focus(info);
        fireEvent.click(
          screen.getByRole("button", {
            name: APP_I18N_RESOURCES[locale].components.common.settings,
          }),
        );
        fireEvent.click(screen.getByRole("menuitem", { name: text.shortcuts }));
        expect(onHelp).toHaveBeenCalledOnce();
      },
    );
  }
});
