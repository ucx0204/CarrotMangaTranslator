/** @vitest-environment jsdom */

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Modal } from "../src/renderer/src/components/ui/Modal";
import { NumberField } from "../src/renderer/src/components/ui/NumberField";
import { ResizeHandle } from "../src/renderer/src/components/ui/ResizeHandle";
import { findAdjacentFocusable } from "../src/renderer/src/components/ui/focusOrder";

// jsdom has no layout, so every element reports a null offsetParent and would
// count as hidden to the focus-order helpers. Treat connected nodes as laid out.
const offsetParent = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetParent",
);
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      return this.isConnected ? this.ownerDocument.body : null;
    },
  });
});
afterAll(() => {
  if (offsetParent) {
    Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent);
  }
});
afterEach(cleanup);

describe("Modal focus trap", () => {
  function DialogOverPage(): React.JSX.Element {
    return (
      <>
        <button type="button">배경 버튼</button>
        <Modal title="설정" onClose={() => undefined}>
          <button type="button">첫 동작</button>
          <button type="button">마지막 동작</button>
        </Modal>
      </>
    );
  }

  it("keeps the first Shift+Tab from the freshly opened card inside the dialog", () => {
    render(<DialogOverPage />);
    const dialog = screen.getByRole("dialog", { name: "설정" });
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "마지막 동작" }),
    );
  });

  it("enters at the first control on Tab and still wraps at both ends", () => {
    render(<DialogOverPage />);
    const dialog = screen.getByRole("dialog", { name: "설정" });
    const close = screen.getByRole("button", { name: "닫기" });
    const last = screen.getByRole("button", { name: "마지막 동작" });

    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(close);
  });
});

describe("NumberField step buttons", () => {
  it("names the two step buttons by direction unless the caller overrides them", () => {
    render(
      <>
        <NumberField
          variant="scrubber"
          ariaLabel="너비"
          value={10}
          min={0}
          max={100}
          onValueChange={() => undefined}
        />
        <NumberField
          variant="scrubber"
          ariaLabel="회전"
          decreaseLabel="왼쪽으로 회전"
          increaseLabel="오른쪽으로 회전"
          value={10}
          min={0}
          max={100}
          onValueChange={() => undefined}
        />
      </>,
    );
    expect(screen.getByRole("button", { name: "너비 줄이기" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "너비 늘리기" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "왼쪽으로 회전" })).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "너비" })).toHaveLength(0);
  });

  function BoundedRow(): React.JSX.Element {
    const [value, setValue] = React.useState(50);
    return (
      <>
        <NumberField
          variant="scrubber"
          ariaLabel="너비"
          value={value}
          min={0}
          max={100}
          onValueChange={setValue}
        />
        <button type="button">다음 컨트롤</button>
      </>
    );
  }

  it("moves past a step button that the committed maximum disables under focus", () => {
    render(<BoundedRow />);
    const input = screen.getByRole("spinbutton", { name: "너비" });
    const increase = screen.getByRole("button", { name: "너비 늘리기" });

    input.focus();
    fireEvent.change(input, { target: { value: "100" } });
    // Tab from the value: the browser focuses "+" while the blur commits 100.
    act(() => increase.focus());

    expect((increase as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "다음 컨트롤" }),
    );
  });

  it("returns to the value when a click on a step button reaches the bound", () => {
    render(<BoundedRow />);
    const input = screen.getByRole("spinbutton", { name: "너비" });
    input.focus();
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const increase = screen.getByRole("button", { name: "너비 늘리기" });
    increase.focus();
    fireEvent.click(increase);

    expect((increase as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it("cancels a draft with Escape without leaving the field, then lets Escape through", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={(event) => outer(event.key)}>
        <NumberField
          variant="scrubber"
          ariaLabel="크기"
          value={24}
          min={1}
          max={512}
          onValueChange={() => undefined}
        />
      </div>,
    );
    const input = screen.getByRole("spinbutton", {
      name: "크기",
    }) as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "9999999" } });

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("24");
    expect(document.activeElement).toBe(input);
    expect(outer).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).toBe(input);
    expect(outer).toHaveBeenCalledWith("Escape");
  });
});

describe("findAdjacentFocusable", () => {
  it("walks Tab order both ways, skipping inert and disabled controls, inside the dialog", () => {
    render(
      <>
        <button type="button">페이지 버튼</button>
        <div role="dialog" aria-label="창">
          <button type="button">앞</button>
          <div inert>
            <button type="button">비활성 영역</button>
          </div>
          <button type="button" disabled>
            기준
          </button>
          <button type="button" disabled>
            꺼짐
          </button>
          <button type="button">뒤</button>
        </div>
      </>,
    );
    const from = screen.getByText("기준");
    expect(findAdjacentFocusable(from, 1)?.textContent).toBe("뒤");
    expect(findAdjacentFocusable(from, -1)?.textContent).toBe("앞");
    const last = screen.getByRole("button", { name: "뒤" });
    expect(findAdjacentFocusable(last, 1)).toBeNull();
    const page = screen.getByRole("button", { name: "페이지 버튼" });
    expect(findAdjacentFocusable(page, -1)).toBeNull();
  });
});

describe("ResizeHandle current value", () => {
  it("exposes the measured size while no size is stored, and the stored one after", () => {
    const measure = vi.fn(() => 312.4);
    const props = {
      orientation: "vertical" as const,
      label: "왼쪽 패널 너비 조절",
      valueMin: 240,
      valueMax: 760,
      measureValue: measure,
      onResizeStart: vi.fn(),
      onResize: vi.fn(),
      onResizeEnd: vi.fn(),
      onReset: vi.fn(),
    };
    const view = render(<ResizeHandle {...props} />);
    const handle = screen.getByRole("separator");
    expect(handle.getAttribute("aria-valuenow")).toBe("312");

    measure.mockReturnValue(298);
    fireEvent.focus(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe("298");

    view.rerender(<ResizeHandle {...props} valueNow={400} />);
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
  });
});
