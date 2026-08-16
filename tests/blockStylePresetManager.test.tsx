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
import {
  ALL_BLOCK_FORMAT_GROUP_IDS,
  DEFAULT_BLOCK_FORMAT_DEFAULTS,
} from "../src/shared/blockFormat";
import {
  createBlockStylePresetFromDefaults,
  type BlockStylePreset,
  type BlockStylePresetGroup,
} from "../src/shared/blockStylePresets";
import { chooseCustomSelectOption } from "./testUtils/customSelect";
import { dismissToast, getToasts } from "../src/renderer/src/lib/toastStore";

const fontsContext: FontsContextValue = {
  baseOptions: [],
  busy: false,
  catalog: DEFAULT_BLOCK_FONT_CATALOG,
  options: [],
  registerFont: async () => undefined,
  removeFont: async () => undefined,
  savePreferences: async () => undefined,
};

afterEach(() => {
  cleanup();
  getToasts().forEach((item) => dismissToast(item.id));
});

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
    expect(
      screen.getByRole("button", { name: "편집 화면으로" }),
    ).not.toBeNull();
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
      ALL_BLOCK_FORMAT_GROUP_IDS.length,
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

  it("shows an enabled text effect value and swatch in preset details", () => {
    const preset = {
      ...makePreset("그림자 대사", "style-preset:shadow"),
      format: {
        ...makePreset("그림자 대사", "style-preset:shadow").format,
        textEffect: {
          enabled: true,
          color: "#123456",
          offsetXpx: -2.5,
          offsetYpx: 4,
          blurPx: 8.5,
          opacity: 0.35,
        },
      },
    } satisfies BlockStylePreset;
    const { container } = render(<ManagerHarness initialPresets={[preset]} />);

    fireEvent.click(screen.getByRole("button", { name: "프리셋 관리" }));

    expect(screen.getByText("#123456 · -2.5/4px · 8.5px · 35%")).not.toBeNull();
    expect(
      container.querySelector(
        '.style-preset-property i[style*="background-color: rgb(18, 52, 86)"]',
      ),
    ).not.toBeNull();
  });

  it("expands grouped presets inline and collapses them back into one folder tab", () => {
    const group: BlockStylePresetGroup = {
      id: "style-preset-group:romance",
      name: "순정만화",
    };
    const ungrouped = makePreset("공통 대사", "style-preset:common");
    const grouped = {
      ...makePreset("감정 대사", "style-preset:romance"),
      groupId: group.id,
    };
    const { container } = render(
      <ManagerHarness
        initialGroups={[group]}
        initialPresets={[ungrouped, grouped]}
      />,
    );

    expect(screen.getByRole("tab", { name: "공통 대사" })).not.toBeNull();
    expect(screen.queryByRole("tab", { name: "감정 대사" })).toBeNull();

    const groupButton = screen.getByRole("button", { name: /순정만화/ });
    expect(groupButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(groupButton);

    const child = screen.getByRole("tab", { name: "감정 대사" });
    expect(child.getAttribute("data-grouped")).toBe("true");
    fireEvent.click(child);
    expect(child.getAttribute("aria-selected")).toBe("true");
    expect(groupButton.getAttribute("data-contains-active")).toBe("true");

    fireEvent.click(groupButton);
    expect(screen.queryByRole("tab", { name: "감정 대사" })).toBeNull();
    expect(container.querySelector(".style-preset-group-children")).toBeNull();
  });

  it("creates groups, assigns presets, and releases a group without deleting its presets", () => {
    render(
      <ManagerHarness
        initialPresets={[makePreset("효과음", "style-preset:sfx")]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "프리셋 관리" }));
    fireEvent.click(screen.getByRole("button", { name: "그룹 추가" }));
    const groupName = screen.getByRole("textbox", { name: "그룹 이름" });
    expect((groupName as HTMLInputElement).value).toBe("새 그룹");
    fireEvent.change(groupName, { target: { value: "액션만화" } });

    chooseCustomSelectOption("프리셋 그룹", "액션만화");
    fireEvent.click(screen.getByRole("button", { name: "그룹 해제" }));

    expect(screen.getByRole("option", { name: /효과음/ })).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "그룹 이름" })).toBeNull();
    expect(
      (
        screen.getByRole("combobox", {
          name: "프리셋 그룹",
        }) as HTMLButtonElement
      ).value,
    ).toBe("__ungrouped__");
  });

  it("moves a preset within its visible group instead of across hidden siblings", () => {
    const group: BlockStylePresetGroup = {
      id: "style-preset-group:action",
      name: "액션만화",
    };
    render(
      <ManagerHarness
        initialGroups={[group]}
        initialPresets={[
          {
            ...makePreset("효과음 A", "style-preset:sfx-a"),
            groupId: group.id,
          },
          makePreset("공통 대사", "style-preset:common"),
          {
            ...makePreset("효과음 B", "style-preset:sfx-b"),
            groupId: group.id,
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "프리셋 관리" }));
    fireEvent.click(screen.getByRole("option", { name: /효과음 B/ }));
    const movePresetUp = screen
      .getAllByRole("button", { name: "위로 이동" })
      .find((button) => !button.hasAttribute("aria-label"));
    expect(movePresetUp).toBeTruthy();
    fireEvent.click(movePresetUp as HTMLButtonElement);

    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["공통 대사", "효과음 B", "효과음 A"]);
  });

  it("prevents removing the final field in the management screen", () => {
    const preset = createBlockStylePresetFromDefaults({
      defaults: DEFAULT_BLOCK_FORMAT_DEFAULTS,
      groupIds: ["color"],
      id: "style-preset:single-field",
      name: "단일 항목",
      pinned: false,
    });
    render(<ManagerHarness initialPresets={[preset]} />);

    fireEvent.click(screen.getByRole("button", { name: "프리셋 관리" }));
    const color = screen.getByRole("checkbox", { name: /글자색/ });
    fireEvent.click(color);

    expect(color).toHaveProperty("checked", true);
    expect(getToasts()[0]).toMatchObject({
      variant: "warn",
      message: "프리셋에는 최소 1개 항목을 적용해야 합니다.",
    });
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
  initialGroups = [],
  initialPresets,
}: {
  initialGroups?: BlockStylePresetGroup[];
  initialPresets: BlockStylePreset[];
}): React.JSX.Element {
  const [activePresetId, setActivePresetId] = React.useState<string | null>(
    null,
  );
  const [groups, setGroups] = React.useState(initialGroups);
  const [presets, setPresets] = React.useState(initialPresets);
  return (
    <FontsContext.Provider value={fontsContext}>
      <BlockStylePresetManager
        activePresetId={activePresetId}
        defaults={DEFAULT_BLOCK_FORMAT_DEFAULTS}
        groups={groups}
        presets={presets}
        onActivePresetChange={setActivePresetId}
        onChange={setPresets}
        onGroupsChange={setGroups}
      />
    </FontsContext.Provider>
  );
}
