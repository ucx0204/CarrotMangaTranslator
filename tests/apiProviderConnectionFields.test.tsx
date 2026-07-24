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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENROUTER_BASE_URL } from "../src/shared/apiProviderPresets";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { appI18n, initializeAppI18n } from "../src/renderer/src/appI18n";
import { ApiProviderConnectionFields } from "../src/renderer/src/components/settingsModal/ApiProviderConnectionFields";
import { AppI18nProvider } from "../src/renderer/src/i18n";

beforeEach(async () => {
  await initializeAppI18n("en");
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await appI18n.changeLanguage("ko");
});

describe("API provider connection fields", () => {
  it("keeps manual inputs while a template can fill verified model settings", async () => {
    const discoverApiModels = vi.fn().mockResolvedValue({
      provider: "openrouter",
      models: [
        {
          id: "vendor/vision-model",
          label: "Vision Model",
          baseUrl: OPENROUTER_BASE_URL,
        },
      ],
      checkedCount: 2,
      unverifiedCount: 1,
    });
    const openApiProviderPage = vi.fn().mockResolvedValue(undefined);
    window.mangaApi = createTestMangaGatewayStub({
      discoverApiModels,
      openApiProviderPage,
      onUiLocaleChanged: () => () => undefined,
    });

    render(
      <AppI18nProvider>
        <Harness />
      </AppI18nProvider>,
    );

    const baseUrl = screen.getByLabelText("API base URL");
    const manualModel = screen.getByLabelText("API model");
    expect(readValue(baseUrl)).toBe("https://private.example/v1");
    expect(readValue(manualModel)).toBe("manual-vision-model");

    fireEvent.change(screen.getByLabelText("Quick API provider setup"), {
      target: { value: "openrouter" },
    });
    expect(readValue(baseUrl)).toBe(OPENROUTER_BASE_URL);

    const keyInput = screen.getByLabelText("API key");
    fireEvent.change(keyInput, { target: { value: "key-a\nkey-b" } });
    expect(readValue(keyInput)).toBe("key-a\nkey-b");

    fireEvent.click(screen.getByRole("button", { name: "Load models" }));
    await waitFor(() => expect(discoverApiModels).toHaveBeenCalledTimes(1));
    expect(discoverApiModels).toHaveBeenCalledWith({
      provider: "openrouter",
      apiKey: "key-a\nkey-b",
    });

    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Vision Model/ })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Verified image-input model"), {
      target: { value: "vendor/vision-model" },
    });
    expect(readValue(baseUrl)).toBe(OPENROUTER_BASE_URL);
    expect(readValue(manualModel)).toBe("vendor/vision-model");

    fireEvent.change(manualModel, { target: { value: "my/manual-model" } });
    expect(readValue(manualModel)).toBe("my/manual-model");

    fireEvent.click(screen.getByRole("button", { name: "Open API key page" }));
    expect(openApiProviderPage).toHaveBeenCalledWith("openrouter");

    fireEvent.click(screen.getByRole("button", { name: "reset" }));
    await waitFor(() =>
      expect(readValue(screen.getByLabelText("Quick API provider setup"))).toBe(
        "custom",
      ),
    );
    expect(screen.queryByLabelText("Verified image-input model")).toBeNull();
  });

  it("invalidates an in-flight model discovery when the fields unmount", async () => {
    let rejectRequest: ((reason?: unknown) => void) | undefined;
    const request = new Promise<never>((_resolve, reject) => {
      rejectRequest = reject;
    });
    const discoverApiModels = vi.fn(() => request);
    window.mangaApi = createTestMangaGatewayStub({
      discoverApiModels,
      onUiLocaleChanged: () => () => undefined,
    });
    const view = render(
      <AppI18nProvider>
        <Harness />
      </AppI18nProvider>,
    );
    fireEvent.change(screen.getByLabelText("Quick API provider setup"), {
      target: { value: "openrouter" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load models" }));
    await waitFor(() => expect(discoverApiModels).toHaveBeenCalledOnce());
    view.unmount();

    const stringify = vi.fn(() => "late discovery failure");
    const lateFailure = { toString: stringify };
    const observedRejection = expect(request).rejects.toBe(lateFailure);
    await act(async () => {
      rejectRequest?.(lateFailure);
      await observedRejection;
    });
    expect(stringify).not.toHaveBeenCalled();
  });
});

function readValue(element: HTMLElement): string {
  return (element as HTMLInputElement | HTMLTextAreaElement).value;
}

function Harness(): React.JSX.Element {
  const [apiBaseUrl, setApiBaseUrl] = React.useState(
    "https://private.example/v1",
  );
  const [apiModel, setApiModel] = React.useState("manual-vision-model");
  const [apiKey, setApiKey] = React.useState("");
  const [apiKeyMaxAttempts, setApiKeyMaxAttempts] = React.useState("2");
  const [apiRetryDelaySeconds, setApiRetryDelaySeconds] = React.useState("1");

  return (
    <>
      <ApiProviderConnectionFields
        apiBaseUrl={apiBaseUrl}
        apiModel={apiModel}
        apiKey={apiKey}
        apiKeyMaxAttempts={apiKeyMaxAttempts}
        apiRetryDelaySeconds={apiRetryDelaySeconds}
        clearTestState={() => undefined}
        controlsBusy={false}
        setApiBaseUrl={setApiBaseUrl}
        setApiModel={setApiModel}
        setApiKey={setApiKey}
        setApiKeyMaxAttempts={setApiKeyMaxAttempts}
        setApiRetryDelaySeconds={setApiRetryDelaySeconds}
        submit={() => undefined}
      />
      <button
        type="button"
        onClick={() => {
          setApiBaseUrl("https://private.example/v1");
          setApiModel("manual-vision-model");
          setApiKey("");
        }}
      >
        reset
      </button>
    </>
  );
}
