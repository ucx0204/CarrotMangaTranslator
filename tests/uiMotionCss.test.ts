import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");

function readRendererCss(relativePath: string): string {
  return readFileSync(
    path.join(ROOT, "src/renderer/src", relativePath),
    "utf8",
  );
}

describe("renderer motion CSS", () => {
  const foundationsCss = readRendererCss("styles/foundations.css");
  const modalCss = readRendererCss("components/ui/Modal.module.css");
  const buttonCss = readRendererCss("components/ui/Button.module.css");
  const iconButtonCss = readRendererCss("components/ui/IconButton.module.css");
  const blockReadingOrderCss = readRendererCss(
    "styles/block-reading-order.css",
  );
  const pageReviewCss = readRendererCss("styles/page-review.css");
  const toastCss = readRendererCss("styles/modals-share.css");

  it("keeps surface entrances reducible without clipping or scaling content", () => {
    expect(foundationsCss).toContain("@keyframes ui-surface-enter");
    expect(foundationsCss).toContain("@keyframes ui-surface-enter-reduced");
    const entrance = foundationsCss
      .split(/@keyframes\s+ui-surface-enter\s*\{/u)[1]
      .split("@keyframes ui-surface-enter-reduced")[0];
    expect(entrance).toContain("translate: none");
    expect(entrance).not.toMatch(/clip-path:|filter:|scale:/u);
  });

  it("settles the modal backdrop and card independently", () => {
    expect(modalCss).toContain(
      "animation: modal-backdrop-enter var(--motion-overlay) var(--ease-enter) both",
    );
    expect(modalCss).toContain(
      "animation: modal-card-enter var(--motion-overlay) var(--ease-enter) both",
    );
    expect(modalCss).toContain("@keyframes modal-backdrop-enter");
    expect(modalCss).toContain("@keyframes modal-card-enter");
    expect(modalCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(modalCss).toContain("modal-card-enter-reduced");
  });

  it.each([
    "components/ui/Select.module.css",
    "components/ui/RadioMenu.module.css",
    "components/ConditionalBatchEditor.module.css",
    "styles/formatting.css",
    "styles/gather-selection.css",
    "styles/library-inpainting.css",
    "styles/linked-workspace.css",
    "styles/panels.css",
    "styles/shell-workspace.css",
    "styles/stage-overlay.css",
    "styles/work-center.css",
  ])("keeps %s entrance motion reducible", (relativePath) => {
    const css = readRendererCss(relativePath);
    expect(css).toContain("animation: ui-surface-enter");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation-name: ui-surface-enter-reduced");
  });

  it("reduces button press motion and keeps icon feedback stationary", () => {
    expect(buttonCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(buttonCss).toContain("transform: none");
    expect(iconButtonCss).not.toMatch(/\b(?:transform|translate|scale):/u);
  });

  it("animates detail disclosure and toasts without layout-size tweening", () => {
    expect(blockReadingOrderCss).toContain(
      "@keyframes page-block-detail-enter",
    );
    expect(toastCss).toContain(
      "animation: toast-in var(--motion-surface) var(--ease-enter) both",
    );
    expect(pageReviewCss).not.toMatch(/animation[^;]*(?:height|width)/u);
    expect(blockReadingOrderCss).not.toMatch(/animation[^;]*(?:height|width)/u);
    expect(toastCss).not.toMatch(/animation[^;]*(?:height|width)/u);
  });
});
