// @vitest-environment jsdom

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
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { CodexAccountSnapshot } from "../src/shared/codexAccountTypes";
import type { CodexReasoningEffort } from "../src/shared/settingsTypes";
import { CodexSettingsFields } from "../src/renderer/src/components/settingsModal/CodexSettingsFields";
import {
  chooseCustomSelectOption,
  customSelectOptionValues,
} from "./testUtils/customSelect";

const catalog = [
  {
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    supportedReasoningEfforts: [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ],
    defaultReasoningEffort: "low",
    isDefault: true,
  },
  {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
    isDefault: false,
  },
] satisfies CodexAccountSnapshot["models"];

const signedOutAccount = {
  authenticated: false,
  accountKind: null,
  email: null,
  planType: null,
  requiresOpenaiAuth: true,
  appServerVersion: "0.150.1",
  models: [],
} satisfies CodexAccountSnapshot;

const signedInAccount = {
  authenticated: true,
  accountKind: "chatgpt",
  email: "reader@example.com",
  planType: "plus",
  requiresOpenaiAuth: true,
  appServerVersion: "0.150.1",
  models: catalog,
} satisfies CodexAccountSnapshot;

const accountGateway = {
  get: vi.fn<() => Promise<CodexAccountSnapshot>>(),
  login: vi.fn<() => Promise<CodexAccountSnapshot>>(),
  logout: vi.fn<() => Promise<CodexAccountSnapshot>>(),
};

beforeEach(() => {
  accountGateway.get.mockReset();
  accountGateway.login.mockReset();
  accountGateway.logout.mockReset();
  accountGateway.get.mockResolvedValue(signedInAccount);
  accountGateway.login.mockResolvedValue(signedInAccount);
  accountGateway.logout.mockResolvedValue(signedOutAccount);
  window.mangaApi = createTestMangaGatewayStub({
    getCodexAccount: accountGateway.get,
    loginCodexAccount: accountGateway.login,
    logoutCodexAccount: accountGateway.logout,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "mangaApi");
});

describe("CodexSettingsFields", () => {
  it("loads the catalog after StrictMode effect cleanup and replay", async () => {
    render(
      <React.StrictMode>
        <Harness initialModel="gpt-5.6-sol" initialEffort="low" />
      </React.StrictMode>,
    );
    await screen.findByRole("combobox", { name: "Codex 모델" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("discovers Astra and an unregistered future model without changing the selection", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    renderHarness("gpt-5.6-sol", "low");
    await screen.findByRole("combobox", { name: "Codex 모델" });
    accountGateway.get.mockResolvedValue({
      ...signedInAccount,
      models: [
        ...catalog,
        {
          ...catalog[0],
          id: "gpt-6-astra",
          displayName: "GPT-6-Astra",
          isDefault: true,
        },
        {
          ...catalog[1],
          id: "future-codex-model",
          displayName: "Future Codex Model",
        },
      ],
    });

    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));

    expect(customSelectOptionValues("Codex 모델")).toEqual([
      "gpt-5.6-sol",
      "gpt-5.5",
      "gpt-6-astra",
      "future-codex-model",
    ]);
    expect(screen.getByTestId("selected-model").textContent).toBe(
      "gpt-5.6-sol",
    );
    chooseCustomSelectOption("Codex 모델", "GPT-6-Astra");
    expect(screen.getByTestId("selected-model").textContent).toBe(
      "gpt-6-astra",
    );
    chooseCustomSelectOption("Codex 모델", "Future Codex Model");
    expect(screen.getByTestId("selected-model").textContent).toBe(
      "future-codex-model",
    );
    expect(customSelectOptionValues(/추론 강도/)).toEqual(
      catalog[1].supportedReasoningEfforts,
    );
  });

  it("preserves the catalog on refresh failure and recovers automatically", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    renderHarness("gpt-5.5", "high");
    await screen.findByRole("combobox", { name: "Codex 모델" });
    accountGateway.get.mockRejectedValueOnce(new Error("Catalog unavailable"));

    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));

    expect(screen.getByRole("alert").textContent).toBe(
      "Codex 인증 상태를 확인하지 못했습니다.",
    );
    expect(screen.getByTestId("selected-model").textContent).toBe("gpt-5.5");
    expect(screen.getByTestId("selected-effort").textContent).toBe("high");
    expect(customSelectOptionValues("Codex 모델")).toEqual(
      catalog.map((model) => model.id),
    );

    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(accountGateway.get).toHaveBeenCalledTimes(3);
  });

  it("refreshes stale catalogs on returning to the window and stops after unmount", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const view = renderHarness("gpt-5.6-sol", "low");
    await screen.findByRole("combobox", { name: "Codex 모델" });
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);

    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(accountGateway.get).toHaveBeenCalledOnce();
    hidden.mockReturnValue(false);
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
    });
    expect(accountGateway.get).toHaveBeenCalledTimes(2);
    await act(async () => {
      fireEvent(window, new Event("focus"));
    });
    expect(accountGateway.get).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + 5 * 60_000);
    await act(async () => {
      fireEvent(window, new Event("focus"));
    });
    expect(accountGateway.get).toHaveBeenCalledTimes(3);
    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    fireEvent(window, new Event("focus"));
    expect(accountGateway.get).toHaveBeenCalledTimes(3);
  });

  it("coalesces refresh triggers and discards a stale result after logout", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    renderHarness("gpt-5.6-sol", "low");
    await screen.findByRole("combobox", { name: "Codex 모델" });
    let resolveRefresh!: (snapshot: CodexAccountSnapshot) => void;
    const pending = new Promise<CodexAccountSnapshot>((resolve) => {
      resolveRefresh = resolve;
    });
    accountGateway.get.mockReturnValueOnce(pending);
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    fireEvent(window, new Event("focus"));
    expect(accountGateway.get).toHaveBeenCalledTimes(2);

    accountGateway.get.mockResolvedValue(signedOutAccount);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    });
    await act(async () => {
      resolveRefresh(signedInAccount);
    });

    expect(accountGateway.get).toHaveBeenCalledTimes(2);
    expect(screen.getByText("로그인되지 않음")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Codex 모델" })).toBeNull();
  });

  it("does not refresh while controls are busy and reloads when available", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const view = renderHarness("gpt-5.6-sol", "low");
    await screen.findByRole("combobox", { name: "Codex 모델" });
    view.rerender(
      <Harness initialModel="gpt-5.6-sol" initialEffort="low" busy />,
    );
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(accountGateway.get).toHaveBeenCalledOnce();

    await act(async () => {
      view.rerender(<Harness initialModel="gpt-5.6-sol" initialEffort="low" />);
    });
    expect(accountGateway.get).toHaveBeenCalledTimes(2);
  });

  it("hides model and reasoning controls until the account is authenticated", async () => {
    accountGateway.get.mockResolvedValueOnce(signedOutAccount);
    renderHarness("gpt-5.6-sol", "low");

    await screen.findByText("로그인되지 않음");

    expect(screen.queryByRole("combobox", { name: "Codex 모델" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /추론 강도/ })).toBeNull();
  });

  it("uses only the model catalog returned by Codex App Server", async () => {
    renderHarness("gpt-5.6-sol", "low");
    await screen.findByRole("combobox", { name: "Codex 모델" });

    expect(customSelectOptionValues("Codex 모델")).toEqual([
      "gpt-5.6-sol",
      "gpt-5.5",
    ]);
    expect(screen.queryByLabelText("Codex 모델 직접 입력")).toBeNull();
  });

  it("renders model and reasoning as two label-and-dropdown rows", async () => {
    renderHarness("gpt-5.6-sol", "low");

    const model = await screen.findByRole("combobox", { name: "Codex 모델" });
    const reasoning = screen.getByRole("combobox", { name: /추론 강도/ });

    expect(
      model
        .closest(".codex-catalog-row")
        ?.classList.contains("codex-catalog-row"),
    ).toBe(true);
    expect(
      reasoning
        .closest(".codex-catalog-row")
        ?.classList.contains("codex-catalog-row"),
    ).toBe(true);
  });

  it("uses only the selected server model's supported reasoning levels", async () => {
    renderHarness("gpt-5.6-sol", "ultra");
    await screen.findByRole("combobox", { name: "Codex 모델" });

    chooseCustomSelectOption("Codex 모델", "GPT-5.5");

    await waitFor(() =>
      expect(screen.getByTestId("selected-effort").textContent).toBe("medium"),
    );
    expect(customSelectOptionValues(/추론 강도/)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("keeps a reasoning level supported by the newly selected model", async () => {
    renderHarness("gpt-5.6-sol", "medium");
    await screen.findByRole("combobox", { name: "Codex 모델" });

    chooseCustomSelectOption("Codex 모델", "GPT-5.5");

    await waitFor(() =>
      expect(screen.getByTestId("selected-model").textContent).toBe("gpt-5.5"),
    );
    expect(screen.getByTestId("selected-effort").textContent).toBe("medium");
  });

  it("changes reasoning effort through the dropdown", async () => {
    renderHarness("gpt-5.6-sol", "low");
    await screen.findByRole("combobox", { name: /추론 강도/ });

    chooseCustomSelectOption(/추론 강도/, "높음");

    expect(screen.getByTestId("selected-effort").textContent).toBe("high");
  });

  it("repairs a missing model and unsupported effort from server defaults", async () => {
    renderHarness("removed-model", "none");

    await waitFor(() => {
      expect(screen.getByTestId("selected-model").textContent).toBe(
        "gpt-5.6-sol",
      );
      expect(screen.getByTestId("selected-effort").textContent).toBe("low");
    });
  });

  it("repairs only the missing model when its effort is still supported", async () => {
    renderHarness("removed-model", "medium");

    await waitFor(() =>
      expect(screen.getByTestId("selected-model").textContent).toBe(
        "gpt-5.6-sol",
      ),
    );
    expect(screen.getByTestId("selected-effort").textContent).toBe("medium");
  });

  it("repairs only an unsupported effort when the model still exists", async () => {
    renderHarness("gpt-5.5", "ultra");

    await waitFor(() =>
      expect(screen.getByTestId("selected-effort").textContent).toBe("medium"),
    );
    expect(screen.getByTestId("selected-model").textContent).toBe("gpt-5.5");
  });

  it("falls back to the first server model when none is marked as default", async () => {
    accountGateway.get.mockResolvedValueOnce({
      ...signedInAccount,
      models: catalog.map((model) => ({ ...model, isDefault: false })),
    });
    renderHarness("removed-model", "medium");

    await waitFor(() =>
      expect(screen.getByTestId("selected-model").textContent).toBe(
        "gpt-5.6-sol",
      ),
    );
  });

  it("signs in before revealing the server-backed controls", async () => {
    accountGateway.get.mockResolvedValueOnce(signedOutAccount);
    renderHarness("gpt-5.6-sol", "low");

    await screen.findByText("로그인되지 않음");
    expect(screen.queryByRole("combobox", { name: "Codex 모델" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ChatGPT로 로그인" }));

    await screen.findByText("reader@example.com");
    expect(screen.getByText("plus 플랜")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Codex 모델" })).toBeTruthy();
    expect(accountGateway.login).toHaveBeenCalledOnce();
  });

  it("hides the server-backed controls after logout", async () => {
    renderHarness("gpt-5.6-sol", "low");

    await screen.findByRole("combobox", { name: "Codex 모델" });
    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));

    await waitFor(() => {
      expect(screen.getByText("로그인되지 않음")).toBeTruthy();
      expect(screen.queryByRole("combobox", { name: "Codex 모델" })).toBeNull();
    });
    expect(accountGateway.logout).toHaveBeenCalledOnce();
  });
});

function renderHarness(
  initialModel: string,
  initialEffort: CodexReasoningEffort,
) {
  return render(
    <Harness initialModel={initialModel} initialEffort={initialEffort} />,
  );
}

function Harness({
  initialModel,
  initialEffort,
  busy = false,
}: {
  initialModel: string;
  initialEffort: CodexReasoningEffort;
  busy?: boolean;
}): React.JSX.Element {
  const [model, setModel] = React.useState(initialModel);
  const [effort, setEffort] = React.useState(initialEffort);
  return (
    <>
      <CodexSettingsFields
        clearTestState={vi.fn()}
        codexModel={model}
        codexReasoningEffort={effort}
        controlsBusy={busy}
        setCodexModel={setModel}
        setCodexReasoningEffort={setEffort}
      />
      <output data-testid="selected-model">{model}</output>
      <output data-testid="selected-effort">{effort}</output>
    </>
  );
}
