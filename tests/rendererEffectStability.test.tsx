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
