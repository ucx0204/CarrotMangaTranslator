/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CollapsibleSection,
  Section,
  SectionHeader,
  type SectionHeaderProps,
} from "../src/renderer/src/components/ui/Section";

afterEach(cleanup);

describe("Section", () => {
  it("supports a reusable header without adding another surface", () => {
    const headerProps: SectionHeaderProps = {
      actions: <span>2개 선택</span>,
      headingLevel: 2,
      title: "검수 범위",
    };
    render(<SectionHeader {...headerProps} />);

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      "검수 범위",
    );
    expect(screen.getByText("2개 선택").textContent).toBe("2개 선택");
  });

  it("names a flat region from its visible heading", () => {
    const onAction = vi.fn();
    render(
      <Section
        actions={<button onClick={onAction}>새로 고침</button>}
        description="현재 범위에 적용됩니다."
        title="번역 설정"
      >
        <span>설정 내용</span>
      </Section>,
    );

    const region = screen.getByRole("region", { name: "번역 설정" });
    expect(within(region).getByRole("heading", { level: 3 }).textContent).toBe(
      "번역 설정",
    );
    expect(within(region).getByText("현재 범위에 적용됩니다.")).toBeTruthy();
    fireEvent.click(within(region).getByRole("button", { name: "새로 고침" }));
    expect(onAction).toHaveBeenCalledOnce();
  });
});

describe("CollapsibleSection", () => {
  it("uses a native disclosure button with linked content", () => {
    function Harness(): React.JSX.Element {
      const [expanded, setExpanded] = React.useState(false);
      return (
        <CollapsibleSection
          description="필요할 때만 펼칩니다."
          expanded={expanded}
          onExpandedChange={setExpanded}
          title="고급 설정"
        >
          <span>고급 내용</span>
        </CollapsibleSection>
      );
    }

    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "고급 설정" });
    const contentId = toggle.getAttribute("aria-controls");
    const content = contentId ? document.getElementById(contentId) : null;

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(content?.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(content?.hidden).toBe(false);
  });
});
