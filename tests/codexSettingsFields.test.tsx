// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexReasoningEffort } from "../src/shared/settingsTypes";
import { CodexSettingsFields } from "../src/renderer/src/components/settingsModal/CodexSettingsFields";
import { resolveCodexReasoningEffortForModel } from "../src/renderer/src/components/settingsOptions";

afterEach(() => cleanup());

describe("CodexSettingsFields", () => {
  it("lists the current visible Codex catalog with Custom last", () => {
    renderHarness("gpt-5.6-sol", "ultra");

    const select = screen.getByRole("combobox", { name: "Codex 모델" });
    expect(
      Array.from((select as HTMLSelectElement).options).map(
        (option) => option.value,
      ),
    ).toEqual([
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

    fireEvent.change(screen.getByRole("combobox", { name: "Codex 모델" }), {
      target: { value: "__custom__" },
    });
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

    fireEvent.change(screen.getByRole("combobox", { name: "Codex 모델" }), {
      target: { value: "gpt-5.5" },
    });

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
});

function renderHarness(
  initialModel: string,
  initialEffort: CodexReasoningEffort,
) {
  function Harness(): React.JSX.Element {
    const [model, setModel] = React.useState(initialModel);
    const [effort, setEffort] = React.useState(initialEffort);
    return (
      <>
        <CodexSettingsFields
          clearTestState={vi.fn()}
          codexModel={model}
          codexOauthPort="10531"
          codexReasoningEffort={effort}
          controlsBusy={false}
          setCodexModel={setModel}
          setCodexOauthPort={vi.fn()}
          setCodexReasoningEffort={setEffort}
          submit={vi.fn()}
        />
        <output data-testid="selected-model">{model}</output>
        <output data-testid="selected-effort">{effort}</output>
      </>
    );
  }

  return render(<Harness />);
}
