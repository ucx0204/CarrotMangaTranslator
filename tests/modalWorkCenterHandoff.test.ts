/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { handoffActiveModalToWorkCenter } from "../src/renderer/src/lib/modalWorkCenterHandoff";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("modal Work Center handoff", () => {
  it("flies a decorative dialog clone to the Work Center target", () => {
    vi.useFakeTimers();
    const dialog = document.createElement("section");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.innerHTML = '<button id="confirm" tabindex="0">확인</button>';
    stubRect(dialog, rect(120, 180, 720, 460));
    const target = document.createElement("button");
    target.setAttribute("data-work-center-handoff-target", "");
    stubRect(target, rect(1_160, 700, 40, 40));
    document.body.append(dialog, target);

    expect(handoffActiveModalToWorkCenter()).toBe(true);
    const ghost = document.querySelector<HTMLElement>(
      ".work-center-handoff-ghost",
    );
    expect(ghost).not.toBeNull();
    expect(ghost?.getAttribute("aria-hidden")).toBe("true");
    expect(ghost?.hasAttribute("role")).toBe(false);
    expect(ghost?.querySelector("[id]")).toBeNull();
    expect(ghost?.style.getPropertyValue("--handoff-target-x")).toBe("700px");
    expect(ghost?.style.getPropertyValue("--handoff-target-y")).toBe("310px");

    ghost?.dispatchEvent(new Event("animationend"));
    expect(document.querySelector(".work-center-handoff-ghost")).toBeNull();
    expect(target.classList.contains("work-center-handoff-arrival")).toBe(true);
    target.dispatchEvent(new Event("animationend"));
    expect(target.classList.contains("work-center-handoff-arrival")).toBe(
      false,
    );
  });

  it("uses one GPU-friendly sampled curve without blur keyframes", () => {
    vi.useFakeTimers();
    const originalAnimate = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "animate",
    );
    const animation = new EventTarget();
    let capturedFrames: Keyframe[] = [];
    let capturedOptions: KeyframeAnimationOptions | number | undefined;
    const animate = vi.fn<HTMLElement["animate"]>((keyframes, options) => {
      capturedFrames = keyframes as Keyframe[];
      capturedOptions = options;
      return animation as Animation;
    });
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    try {
      const dialog = document.createElement("section");
      dialog.setAttribute("role", "dialog");
      stubRect(dialog, rect(120, 180, 720, 460));
      const target = document.createElement("button");
      target.setAttribute("data-work-center-handoff-target", "");
      stubRect(target, rect(1_160, 700, 40, 40));
      document.body.append(dialog, target);

      expect(handoffActiveModalToWorkCenter()).toBe(true);
      expect(animate).toHaveBeenCalledOnce();
      expect(capturedFrames).toHaveLength(25);
      expect(capturedFrames.every((frame) => !("filter" in frame))).toBe(true);
      expect(capturedOptions).toMatchObject({
        duration: 820,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
      });

      animation.dispatchEvent(new Event("finish"));
      expect(document.querySelector(".work-center-handoff-ghost")).toBeNull();
    } finally {
      if (originalAnimate) {
        Object.defineProperty(
          HTMLElement.prototype,
          "animate",
          originalAnimate,
        );
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
      }
    }
  });

  it("does nothing without visible source and target geometry", () => {
    const dialog = document.createElement("section");
    dialog.setAttribute("role", "dialog");
    const target = document.createElement("button");
    target.setAttribute("data-work-center-handoff-target", "");
    document.body.append(dialog, target);

    expect(handoffActiveModalToWorkCenter()).toBe(false);
    expect(document.querySelector(".work-center-handoff-ghost")).toBeNull();
  });
});

function stubRect(element: HTMLElement, value: DOMRect): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(value);
}

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}
