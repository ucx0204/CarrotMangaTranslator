/** @vitest-environment jsdom */
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OLLAMA_BASE_URL,
  OPENROUTER_BASE_URL,
} from "../src/shared/apiProviderPresets";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { appI18n, initializeAppI18n } from "../src/renderer/src/appI18n";
import { ApiProviderConnectionFields } from "../src/renderer/src/components/settingsModal/ApiProviderConnectionFields";
import { AppI18nProvider } from "../src/renderer/src/i18n";
import { SETTINGS_SECRET_PRESERVE_SENTINEL } from "../src/shared/settingsSecrets";
import {
  chooseCustomSelectOption,
  openCustomSelect,
} from "./testUtils/customSelect";

beforeEach(async () => {
  await initializeAppI18n("en");
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await appI18n.changeLanguage("ko");
});

describe("API provider connection fields", () => {
  it("shows the real count for masked keys loaded from encrypted storage", () => {
    window.mangaApi = createTestMangaGatewayStub({
      onUiLocaleChanged: () => () => undefined,
    });
    render(
      <AppI18nProvider>
        <Harness
          initialApiKey={SETTINGS_SECRET_PRESERVE_SENTINEL}
          apiKeyCount={3}
        />
      </AppI18nProvider>,
    );

    expect(screen.getByText(/3 keys are configured and kept/)).not.toBeNull();
  });

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

    chooseCustomSelectOption("Quick API provider setup", "OpenRouter");
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
      expect(
        screen.getByRole("combobox", { name: "Verified image-input model" }),
      ).toBeTruthy(),
    );
    openCustomSelect("Verified image-input model");
    expect(screen.getByRole("option", { name: /Vision Model/ })).toBeTruthy();
    chooseCustomSelectOption("Verified image-input model", /Vision Model/);
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

  it("fills the Ollama base URL, loads models without a key, and opens the library", async () => {
    const discoverApiModels = vi.fn().mockResolvedValue({
      provider: "ollama",
      models: [
        { id: "llava:latest", label: "llava:latest", baseUrl: OLLAMA_BASE_URL },
      ],
      checkedCount: 1,
      unverifiedCount: 0,
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
    chooseCustomSelectOption("Quick API provider setup", "Ollama (local)");
    expect(readValue(baseUrl)).toBe(OLLAMA_BASE_URL);

    fireEvent.click(screen.getByRole("button", { name: "Load models" }));
    await waitFor(() => expect(discoverApiModels).toHaveBeenCalledTimes(1));
    expect(discoverApiModels).toHaveBeenCalledWith({
      provider: "ollama",
      apiKey: "",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Open Ollama model library" }),
    );
    expect(openApiProviderPage).toHaveBeenCalledWith("ollama");
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
    chooseCustomSelectOption("Quick API provider setup", "OpenRouter");
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

  it("selects a validated Vertex service-account JSON and uses it for discovery", async () => {
    const openVertexSetupPage = vi.fn().mockResolvedValue({
      opened: true,
      url: "https://console.cloud.google.com/",
    });
    const pickVertexServiceAccountFile = vi.fn().mockResolvedValue({
      filePath: "C:\\keys\\vertex-service.json",
      fileName: "vertex-service.json",
      projectId: "sample-project",
      clientEmail: "translator@sample-project.iam.gserviceaccount.com",
    });
    const discoverApiModels = vi.fn().mockResolvedValue({
      provider: "google-vertex",
      models: [],
      checkedCount: 0,
      unverifiedCount: 0,
    });
    window.mangaApi = createTestMangaGatewayStub({
      discoverApiModels,
      openVertexSetupPage,
      pickVertexServiceAccountFile,
      onUiLocaleChanged: () => () => undefined,
    });

    render(
      <AppI18nProvider>
        <Harness />
      </AppI18nProvider>,
    );

    chooseCustomSelectOption("Quick API provider setup", "Google Vertex AI");
    fireEvent.click(
      screen.getByRole("button", { name: "Service account JSON" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open Vertex authentication guide" }),
    );
    const guideDialog = screen.getByRole("dialog", {
      name: "Set up a Vertex service account JSON",
    });
    expect(within(guideDialog).queryByText(/Gemini API/)).toBeNull();
    expect(
      within(guideDialog).getByText("Vertex AI usage and credits").tagName,
    ).toBe("STRONG");
    expect(
      within(guideDialog).queryByText("Protect the JSON file like a password"),
    ).toBeNull();

    const guidePages = [
      ["Create project", "project-create"],
      ["Open Vertex AI API", "vertex-ai-api"],
      ["Open service accounts", "service-accounts"],
    ] as const;
    for (const [index, [label, page]] of guidePages.entries()) {
      const linkButton = within(guideDialog).getByRole("button", {
        name: label,
      }) as HTMLButtonElement;
      fireEvent.click(linkButton);
      await waitFor(() => {
        expect(openVertexSetupPage).toHaveBeenNthCalledWith(index + 1, page);
        expect(linkButton.disabled).toBe(false);
      });
    }
    fireEvent.click(
      within(guideDialog).getAllByRole("button", { name: "Close" })[1],
    );
    expect(
      screen.queryByRole("dialog", {
        name: "Set up a Vertex service account JSON",
      }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Select JSON" }));

    await waitFor(() =>
      expect(pickVertexServiceAccountFile).toHaveBeenCalled(),
    );
    expect(readValue(screen.getByLabelText("Google Cloud project ID"))).toBe(
      "sample-project",
    );
    expect(screen.getByText("vertex-service.json")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Load models" }));
    await waitFor(() => expect(discoverApiModels).toHaveBeenCalledOnce());
    expect(discoverApiModels).toHaveBeenCalledWith({
      provider: "google-vertex",
      apiKey: "",
      vertexAuthMode: "service-account",
      vertexServiceAccountPath: "C:\\keys\\vertex-service.json",
      vertexProject: "sample-project",
      vertexLocation: "global",
    });
  });

  it("keeps the legacy Vertex token flow usable and reports invalid JSON selections", async () => {
    const openApiProviderPage = vi.fn().mockResolvedValue(undefined);
    const pickVertexServiceAccountFile = vi
      .fn()
      .mockRejectedValue(new Error("Invalid service account JSON"));
    window.mangaApi = createTestMangaGatewayStub({
      openApiProviderPage,
      pickVertexServiceAccountFile,
      onUiLocaleChanged: () => () => undefined,
    });

    render(
      <AppI18nProvider>
        <Harness />
      </AppI18nProvider>,
    );

    chooseCustomSelectOption("Quick API provider setup", "Google Vertex AI");
    const tokenInput = screen.getByLabelText(
      "OAuth access tokens (one per line)",
    );
    expect(tokenInput.classList.contains("masked")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Show API key" }));
    expect(tokenInput.classList.contains("masked")).toBe(false);
    fireEvent.change(tokenInput, { target: { value: "temporary-token" } });
    expect(readValue(tokenInput)).toBe("temporary-token");

    fireEvent.click(
      screen.getByRole("button", { name: "Open Vertex authentication guide" }),
    );
    await waitFor(() =>
      expect(openApiProviderPage).toHaveBeenCalledWith("google-vertex"),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Service account JSON" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Select JSON" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Invalid service account JSON",
    );
  });
});

function readValue(element: HTMLElement): string {
  return (element as HTMLInputElement | HTMLTextAreaElement).value;
}

function Harness({
  initialApiKey = "",
  apiKeyCount = 0,
}: {
  initialApiKey?: string;
  apiKeyCount?: number;
} = {}): React.JSX.Element {
  const [apiBaseUrl, setApiBaseUrl] = React.useState(
    "https://private.example/v1",
  );
  const [apiModel, setApiModel] = React.useState("manual-vision-model");
  const [apiKey, setApiKey] = React.useState(initialApiKey);
  const [apiVertexAuthMode, setApiVertexAuthMode] = React.useState<
    "access-token" | "service-account"
  >("access-token");
  const [apiVertexServiceAccountPath, setApiVertexServiceAccountPath] =
    React.useState("");
  const [apiKeyMaxAttempts, setApiKeyMaxAttempts] = React.useState("2");
  const [apiRetryDelaySeconds, setApiRetryDelaySeconds] = React.useState("1");

  return (
    <>
      <ApiProviderConnectionFields
        apiBaseUrl={apiBaseUrl}
        apiModel={apiModel}
        apiKey={apiKey}
        apiKeyCount={apiKeyCount}
        apiVertexAuthMode={apiVertexAuthMode}
        apiVertexServiceAccountPath={apiVertexServiceAccountPath}
        apiKeyMaxAttempts={apiKeyMaxAttempts}
        apiRetryDelaySeconds={apiRetryDelaySeconds}
        clearTestState={() => undefined}
        controlsBusy={false}
        setApiBaseUrl={setApiBaseUrl}
        setApiModel={setApiModel}
        setApiKey={setApiKey}
        setApiVertexAuthMode={setApiVertexAuthMode}
        setApiVertexServiceAccountPath={setApiVertexServiceAccountPath}
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
