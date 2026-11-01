/** @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRightRail } from "../src/renderer/src/components/AppRightRail";
import { makeRightRailProps } from "./unifiedInpaintingUiFixtures";

vi.stubGlobal(
  "ResizeObserver",
  class {
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  },
);
afterEach(cleanup);

function renderRightRail(props: ReturnType<typeof makeRightRailProps>) {
  return render(<AppRightRail {...props} />);
}

describe("right rail focus across show and hide", () => {
  it("keeps focus visible when chat opens from and closes back to the library button", () => {
    // Like the library header: the chat button exists only while chat is closed.
    const closed = makeRightRailProps({
      currentChapter: null,
      selectedPage: null,
    });
    const Shell = ({ chatOpen }: { chatOpen: boolean }) => (
      <>
        {chatOpen ? null : (
          <button type="button" aria-label="채팅으로 번역">
            채팅
          </button>
        )}
        <AppRightRail {...closed} chatOpen={chatOpen} />
      </>
    );
    const view = render(<Shell chatOpen={false} />);
    screen.getByRole("button", { name: "채팅으로 번역" }).focus();

    view.rerender(<Shell chatOpen />);
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "채팅" }),
    );

    screen.getByRole("tab", { name: "편집" }).focus();
    view.rerender(<Shell chatOpen={false} />);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "채팅으로 번역" }),
    );
  });

  it("returns focus to a still-mounted opener and leaves it alone without one", () => {
    const closed = makeRightRailProps({
      currentChapter: null,
      selectedPage: null,
    });
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = renderRightRail({ ...closed, chatOpen: true });
    screen.getByRole("tab", { name: "편집" }).focus();
    view.rerender(<AppRightRail {...closed} chatOpen={false} />);
    expect(document.activeElement).toBe(opener);

    // An opener that disappeared with no labelled replacement is not guessed.
    view.rerender(<AppRightRail {...closed} chatOpen />);
    opener.remove();
    screen.getByRole("tab", { name: "편집" }).focus();
    view.rerender(<AppRightRail {...closed} chatOpen={false} />);
    expect(document.activeElement).not.toBe(opener);
  });
});
