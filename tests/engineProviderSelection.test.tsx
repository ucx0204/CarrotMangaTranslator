/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "../src/shared/settingsTypes";
import { TranslationEngineSelector } from "../src/renderer/src/components/settingsModal/EngineCommonFields";

afterEach(cleanup);

describe("TranslationEngineSelector", () => {
  it("supports arrow-key movement as one radio group", () => {
    function Harness(): React.JSX.Element {
      const [provider, setProvider] = React.useState<ModelProvider>("gemma");
      return (
        <>
          <TranslationEngineSelector
            clearTestState={vi.fn()}
            controlsBusy={false}
            modelProvider={provider}
            setModelProvider={setProvider}
          />
          <output>{provider}</output>
        </>
      );
    }

    render(<Harness />);
    const radios = screen.getAllByRole("radio");
    expect(radios[0].getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(radios[0], { key: "ArrowRight" });

    expect(screen.getByText("openai-codex")).toBeTruthy();
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    expect(radios[1].getAttribute("tabindex")).toBe("0");
  });
});
