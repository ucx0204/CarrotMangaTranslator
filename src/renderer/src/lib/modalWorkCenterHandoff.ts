const WORK_CENTER_TARGET_SELECTOR = "[data-work-center-handoff-target]";
const HANDOFF_GHOST_CLASS = "work-center-handoff-ghost";
const HANDOFF_FALLBACK_CLASS = "work-center-handoff-ghost-fallback";
const HANDOFF_ARRIVAL_CLASS = "work-center-handoff-arrival";
const HANDOFF_DURATION_MS = 820;
const HANDOFF_FALLBACK_MS = 1_050;
const ARRIVAL_FALLBACK_MS = 600;

/**
 * Leaves a visual copy of the top dialog behind while React moves the real
 * work into the Work Center. Normal close and cancel paths never call this.
 */
export function handoffActiveModalToWorkCenter(): boolean {
  if (typeof document === "undefined") return false;
  const source = findTopVisibleDialog();
  const target = document.querySelector<HTMLElement>(
    WORK_CENTER_TARGET_SELECTOR,
  );
  if (!source || !target) return false;

  const sourceRect = source.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  if (!hasVisibleArea(sourceRect) || !hasVisibleArea(targetRect)) return false;

  const { ghost, motion } = createHandoffGhost(source, sourceRect, targetRect);
  document.body.appendChild(ghost);
  const finish = once(() => {
    ghost.remove();
    animateWorkCenterArrival(target);
  });
  if (!runSmoothHandoffAnimation(ghost, motion, finish)) {
    ghost.classList.add(HANDOFF_FALLBACK_CLASS);
    ghost.addEventListener("animationend", finish, { once: true });
  }
  window.setTimeout(finish, HANDOFF_FALLBACK_MS);
  return true;
}

function findTopVisibleDialog(): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
      .reverse()
      .find((dialog) => hasVisibleArea(dialog.getBoundingClientRect())) ?? null
  );
}

function hasVisibleArea(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

function createHandoffGhost(
  source: HTMLElement,
  sourceRect: DOMRect,
  targetRect: DOMRect,
): { ghost: HTMLElement; motion: HandoffMotion } {
  const ghost = source.cloneNode(true) as HTMLElement;
  makeCloneDecorative(ghost);
  const sourceCenter = centerOf(sourceRect);
  const targetCenter = centerOf(targetRect);
  const x = targetCenter.x - sourceCenter.x;
  const y = targetCenter.y - sourceCenter.y;
  const distance = Math.hypot(x, y);
  const arc = Math.min(190, Math.max(72, distance * 0.17));
  const targetScale = Math.min(
    0.12,
    Math.max(
      0.035,
      Math.min(
        targetRect.width / sourceRect.width,
        targetRect.height / sourceRect.height,
      ),
    ),
  );

  ghost.classList.add(HANDOFF_GHOST_CLASS);
  Object.assign(ghost.style, {
    left: `${sourceRect.left}px`,
    top: `${sourceRect.top}px`,
    width: `${sourceRect.width}px`,
    height: `${sourceRect.height}px`,
  });
  setMotionPoint(ghost, "mid", x * 0.46, y * 0.46 - arc);
  setMotionPoint(ghost, "late", x * 0.82, y * 0.82 - arc * 0.48);
  setMotionPoint(ghost, "target", x, y);
  ghost.style.setProperty("--handoff-target-scale", String(targetScale));
  return { ghost, motion: { arc, targetScale, x, y } };
}

type HandoffMotion = {
  arc: number;
  targetScale: number;
  x: number;
  y: number;
};

function runSmoothHandoffAnimation(
  ghost: HTMLElement,
  motion: HandoffMotion,
  finish: () => void,
): boolean {
  if (typeof ghost.animate !== "function") return false;
  const reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animation = ghost.animate(
    reducedMotion
      ? [
          { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
          { opacity: 0, transform: "translate3d(0, 0, 0) scale(0.96)" },
        ]
      : buildSmoothFlightFrames(motion),
    {
      duration: reducedMotion ? 160 : HANDOFF_DURATION_MS,
      easing: reducedMotion ? "ease-out" : "cubic-bezier(0.4, 0, 0.2, 1)",
      fill: "both",
    },
  );
  animation.addEventListener("finish", finish, { once: true });
  animation.addEventListener("cancel", finish, { once: true });
  return true;
}

function buildSmoothFlightFrames(motion: HandoffMotion): Keyframe[] {
  const steps = 24;
  return Array.from({ length: steps + 1 }, (_unused, index) => {
    const progress = index / steps;
    const x = motion.x * progress;
    const y = motion.y * progress - 4 * motion.arc * progress * (1 - progress);
    const scale = 1 - (1 - motion.targetScale) * Math.pow(progress, 0.92);
    const opacity = Math.max(0, 1 - Math.pow(progress, 1.45));
    return {
      offset: progress,
      opacity,
      transform: `translate3d(${x}px, ${y}px, 0) scale(${scale})`,
    };
  });
}

function centerOf(rect: DOMRect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function setMotionPoint(
  ghost: HTMLElement,
  name: "mid" | "late" | "target",
  x: number,
  y: number,
): void {
  ghost.style.setProperty(`--handoff-${name}-x`, `${x}px`);
  ghost.style.setProperty(`--handoff-${name}-y`, `${y}px`);
}

function makeCloneDecorative(ghost: HTMLElement): void {
  ghost.removeAttribute("role");
  ghost.removeAttribute("aria-modal");
  ghost.removeAttribute("aria-label");
  ghost.removeAttribute("aria-labelledby");
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("inert", "");
  for (const element of ghost.querySelectorAll<HTMLElement>(
    "[id], [tabindex]",
  )) {
    element.removeAttribute("id");
    element.removeAttribute("tabindex");
  }
}

function animateWorkCenterArrival(target: HTMLElement): void {
  target.classList.remove(HANDOFF_ARRIVAL_CLASS);
  void target.offsetWidth;
  target.classList.add(HANDOFF_ARRIVAL_CLASS);
  const finish = once(() => target.classList.remove(HANDOFF_ARRIVAL_CLASS));
  target.addEventListener("animationend", finish, { once: true });
  window.setTimeout(finish, ARRIVAL_FALLBACK_MS);
}

function once(callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback();
  };
}
