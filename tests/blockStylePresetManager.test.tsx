/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BlockStylePresetManager } from "../src/renderer/src/components/settingsModal/BlockStylePresetManager";
import {
  FontsContext,
  type FontsContextValue,
} from "../src/renderer/src/fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../src/shared/blockFormat";
import {
  createBlockStylePresetFromDefaults,
  type BlockStylePreset,
} from "../src/shared/blockStylePresets";

const fontsContext: FontsContextValue = {
  baseOptions: [],
  busy: false,
  catalog: DEFAULT_BLOCK_FONT_CATALOG,
  options: [],
  registerFont: async () => undefined,
  removeFont: async () => undefined,
  savePreferences: async () => undefined,
};

afterEach(cleanup);

describe("block style preset manager", () => {
  it("keeps management inside the existing settings surface", () => {
    const { container } = render(<ManagerHarness initialPresets={[]} />);

    expect(screen.getByRole("heading", { name: "서식 프리셋" })).not.toBeNull();
    expect(
      container.querySelector(".style-preset-manager-count")?.textContent,
    ).toBe("0");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(container.querySelector(".style-preset-library")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "프리셋 관리" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "기본 서식" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "추가" }));
    expect(screen.getByRole("option", { name: /새 프리셋/ })).not.toBeNull();
    expect(
      (
        screen.getByRole("textbox", {
          name: "프리셋 이름",
        }) as HTMLInputElement
      ).value,
    ).toBe("새 프리셋");
  });

  it("keeps every preset at a stable row height in the management surface", async () => {
    const presets = Array.from({ length: 12 }, (_, index) =>
      makePreset(`프리셋 ${index + 1}`, `style-preset:${index + 1}`),
    );
    const { container } = render(<ManagerHarness initialPresets={presets} />);

    expect(container.querySelector(".style-preset-library")).toBeNull();
    expect(
      container.querySelector(".style-preset-manager-count")?.textContent,
    ).toBe("12");

    fireEvent.click(screen.getByRole("button", { name: "프리셋 관리" }));
    expect(screen.getAllByRole("option")).toHaveLength(12);
    expect(
      container.querySelectorAll(".style-preset-library-preview"),
    ).toHaveLength(0);
    expect(
      container.querySelector(
        '.gather-direct-preview-stage[data-compact="true"]',
      ),
    ).not.toBeNull();
    expect(container.querySelectorAll(".style-preset-property")).toHaveLength(
      12,
    );
    expect(screen.getByText("기본 폰트")).not.toBeNull();
    expect(screen.getByText("가운데 정렬")).not.toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /프리셋 8/ }));
    const nameInput = screen.getByRole("textbox", { name: "프리셋 이름" });
    expect((nameInput as HTMLInputElement).value).toBe("프리셋 8");
    fireEvent.change(nameInput, { target: { value: "효과음" } });

    await waitFor(() =>
      expect(screen.getByRole("option", { name: /효과음/ })).not.toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "복제" }));
    expect(screen.getAllByRole("option")).toHaveLength(13);
    expect(
      screen.getByRole("option", { name: /효과음 복사본/ }),
    ).not.toBeNull();
  });
});

function makePreset(name: string, id: string): BlockStylePreset {
  return createBlockStylePresetFromDefaults({
    defaults: DEFAULT_BLOCK_FORMAT_DEFAULTS,
    id,
    name,
    pinned: false,
  });
}

function ManagerHarness({
  initialPresets,
}: {
  initialPresets: BlockStylePreset[];
}): React.JSX.Element {
  const [presets, setPresets] = React.useState(initialPresets);
  return (
    <FontsContext.Provider value={fontsContext}>
      <BlockStylePresetManager
        defaults={DEFAULT_BLOCK_FORMAT_DEFAULTS}
        presets={presets}
        onChange={setPresets}
      />
    </FontsContext.Provider>
  );
}
