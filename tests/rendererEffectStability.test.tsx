/** @vitest-environment jsdom */

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { useSettingsFormState } from "../src/renderer/src/components/settingsModal/useSettingsFormState";
import { Modal } from "../src/renderer/src/components/ui/Modal";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("renderer effect dependency stability", () => {
  it("opens on the dialog surface instead of highlighting the close action", () => {
    const view = render(
      <Modal title="Edit" onClose={() => undefined}>
        <input aria-label="Name" />
      </Modal>,
    );

    expect(document.activeElement).toBe(view.getByRole("dialog"));
  });

  it("honours an explicitly requested initial modal control", () => {
    const view = render(
      <Modal title="Edit" onClose={() => undefined}>
        <input aria-label="Name" data-modal-initial-focus />
      </Modal>,
    );

    expect(document.activeElement).toBe(view.getByLabelText("Name"));
  });

  it("keeps one Escape listener while an open modal receives fresh root state", () => {
    const onClose = vi.fn();
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const view = render(<ModalHarness progress={1} onClose={onClose} />);

    expect(keyboardListenerCalls(addEventListener)).toHaveLength(1);

    view.rerender(<ModalHarness progress={50} onClose={onClose} />);
    view.rerender(<ModalHarness progress={99} onClose={onClose} />);

    expect(keyboardListenerCalls(addEventListener)).toHaveLength(1);
    expect(keyboardListenerCalls(removeEventListener)).toHaveLength(0);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith(99);

    view.unmount();
    expect(keyboardListenerCalls(removeEventListener)).toHaveLength(1);
  });

  it("keeps settings ref and setter boundaries stable across rerenders", () => {
    const settings = resolveDefaultAppSettings({});
    const { result, rerender } = renderHook(
      ({ progress }: { progress: number }) => {
        void progress;
        return useSettingsFormState(settings);
      },
      { initialProps: { progress: 0 } },
    );
    const initialRefs = result.current.refs;
    const initialSetters = result.current.setters;

    rerender({ progress: 50 });
    expect(result.current.refs).toBe(initialRefs);
    expect(result.current.setters).toBe(initialSetters);

    act(() => {
      result.current.setters.setApiKey("updated-key");
    });
    expect(result.current.values.apiKey).toBe("updated-key");
    expect(result.current.refs).toBe(initialRefs);
    expect(result.current.setters).toBe(initialSetters);
  });

  it("restores provider-specific credentials, limits, and research settings", () => {
    const settings = resolveDefaultAppSettings({});
    const { result } = renderHook(() => useSettingsFormState(settings));

    act(() => {
      result.current.setters.setModelProvider("openai-api");
      result.current.setters.setApiKey("custom-key");
      result.current.setters.setApiModel("custom-model");
      result.current.setters.setMaxTokens("11111");
      result.current.setters.setContextTokens("22222");
      result.current.setters.setResearchApiModel("custom-research");
      result.current.setters.setResearchApiMaxOutputTokens("33333");
      result.current.setters.setResearchApiContextTokens("44444");
    });

    act(() => {
      result.current.setters.setApiProvider("google-ai-studio");
    });
    expect(result.current.values).toMatchObject({
      apiKey: "",
      apiModel: "gemini-3.5-flash-lite",
      maxTokens: "65536",
      contextTokens: "524288",
    });

    act(() => {
      result.current.setters.setApiKey("google-key");
      result.current.setters.setMaxTokens("55555");
      result.current.setters.setContextTokens("66666");
      result.current.setters.setResearchApiModel("google-research");
      result.current.setters.setResearchApiMaxOutputTokens("77777");
      result.current.setters.setResearchApiContextTokens("88888");
      result.current.setters.setApiProvider("custom");
    });
    expect(result.current.values).toMatchObject({
      apiKey: "custom-key",
      apiModel: "custom-model",
      maxTokens: "11111",
      contextTokens: "22222",
      researchApiModel: "custom-research",
      researchApiMaxOutputTokens: "33333",
      researchApiContextTokens: "44444",
    });

    act(() => {
      result.current.setters.setApiProvider("google-ai-studio");
    });
    expect(result.current.values).toMatchObject({
      apiKey: "google-key",
      maxTokens: "55555",
      contextTokens: "66666",
      researchApiModel: "google-research",
      researchApiMaxOutputTokens: "77777",
      researchApiContextTokens: "88888",
    });

    act(() => {
      result.current.setters.setModelProvider("gemma");
      result.current.setters.setMaxTokens("12345");
      result.current.setters.setContextTokens("23456");
      result.current.setters.setModelProvider("openai-codex");
    });
    expect(result.current.values.maxTokens).not.toBe("12345");
    act(() => {
      result.current.setters.setModelProvider("gemma");
    });
    expect(result.current.values).toMatchObject({
      maxTokens: "12345",
      contextTokens: "23456",
    });

    const unchanged = result.current.values;
    act(() => {
      result.current.setters.setModelProvider("gemma");
      result.current.setters.setApiProvider(result.current.values.apiProvider);
    });
    expect(result.current.values).toBe(unchanged);
  });
});

function ModalHarness({
  progress,
  onClose,
}: {
  progress: number;
  onClose: (progress: number) => void;
}): React.JSX.Element {
  return (
    <Modal title="Progress" onClose={() => onClose(progress)}>
      <p>{progress}</p>
    </Modal>
  );
}

function keyboardListenerCalls(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
  return spy.mock.calls.filter(
    ([eventName]: unknown[]) => eventName === "keydown",
  );
}
