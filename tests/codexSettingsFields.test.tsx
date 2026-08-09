// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexReasoningEffort } from "../src/shared/settingsTypes";
import { CodexSettingsFields } from "../src/renderer/src/components/settingsModal/CodexSettingsFields";
import { resolveCodexReasoningEffortForModel } from "../src/renderer/src/components/settingsOptions";
import {
  chooseCustomSelectOption,
  customSelectOptionValues,
} from "./testUtils/customSelect";

afterEach(() => cleanup());

describe("CodexSettingsFields", () => {
  it("lists the current visible Codex catalog with Custom last", () => {
    renderHarness("gpt-5.6-sol", "ultra");

    expect(customSelectOptionValues("Codex 모델")).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
      "__custom__",
    ]);
    expect(screen.queryByLabelText("Codex 모델 직접 입력")).toBeNull();
    expect(screen.getByRole("button", { name: "Ultra" })).toBeTruthy();
  });

  it("reveals a free-form input when Custom is selected", () => {
    renderHarness("gpt-5.6-sol", "low");

    chooseCustomSelectOption("Codex 모델", "직접 입력");
    const input = screen.getByLabelText("Codex 모델 직접 입력");
    fireEvent.change(input, { target: { value: "future-codex-model" } });

    expect(screen.getByTestId("selected-model").textContent).toBe(
      "future-codex-model",
    );
    expect(screen.getByRole("button", { name: "없음" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ultra" })).toBeTruthy();
  });

  it("uses only the selected model's supported reasoning levels", () => {
    renderHarness("gpt-5.6-sol", "ultra");

    chooseCustomSelectOption("Codex 모델", "GPT-5.5");

    expect(screen.queryByRole("button", { name: "Ultra" })).toBeNull();
    expect(screen.queryByRole("button", { name: "최대" })).toBeNull();
    expect(screen.getByTestId("selected-effort").textContent).toBe("medium");
  });

  it("repairs an unsupported saved effort for a known model only", () => {
    expect(resolveCodexReasoningEffortForModel("gpt-5.5", "ultra")).toBe(
      "medium",
    );
    expect(
      resolveCodexReasoningEffortForModel("future-codex-model", "ultra"),
    ).toBe("ultra");
  });

  it("keeps token values unchanged when the selected model changes", () => {
    renderHarness("gpt-5.6-sol", "low");

    chooseCustomSelectOption("Codex 모델", "GPT-5.3-Codex-Spark");

    expect(screen.getByTestId("max-tokens").textContent).toBe("32768");
    expect(screen.getByTestId("context-tokens").textContent).toBe("65536");
  });

  it("preserves a manually edited token value when the model changes", () => {
    renderHarness("gpt-5.6-sol", "low", "20000");

    chooseCustomSelectOption("Codex 모델", "GPT-5.3-Codex-Spark");

    expect(screen.getByTestId("max-tokens").textContent).toBe("20000");
    expect(screen.getByTestId("context-tokens").textContent).toBe("65536");
  });

  it("does not mistake a manual value for a recommendation after a model round trip", () => {
    renderHarness("gpt-5.6-sol", "low", "24576");

    chooseCustomSelectOption("Codex 모델", "GPT-5.3-Codex-Spark");
    chooseCustomSelectOption("Codex 모델", "GPT-5.6-Sol");

    expect(screen.getByTestId("max-tokens").textContent).toBe("24576");
    expect(screen.getByTestId("context-tokens").textContent).toBe("65536");
  });
});

function renderHarness(
  initialModel: string,
  initialEffort: CodexReasoningEffort,
  initialMaxTokens = "32768",
) {
  function Harness(): React.JSX.Element {
    const [model, setModel] = React.useState(initialModel);
    const [effort, setEffort] = React.useState(initialEffort);
    const [maxTokens, setMaxTokens] = React.useState(initialMaxTokens);
    const [contextTokens, setContextTokens] = React.useState("65536");
    return (
      <>
        <CodexSettingsFields
          clearTestState={vi.fn()}
          codexModel={model}
          codexOauthPort="10531"
          codexReasoningEffort={effort}
          contextTokens={contextTokens}
          controlsBusy={false}
          maxTokens={maxTokens}
          setCodexModel={setModel}
          setCodexOauthPort={vi.fn()}
          setCodexReasoningEffort={setEffort}
          setContextTokens={setContextTokens}
          setMaxTokens={setMaxTokens}
          submit={vi.fn()}
        />
        <output data-testid="selected-model">{model}</output>
        <output data-testid="selected-effort">{effort}</output>
        <output data-testid="max-tokens">{maxTokens}</output>
        <output data-testid="context-tokens">{contextTokens}</output>
      </>
    );
  }

  return render(<Harness />);
}
