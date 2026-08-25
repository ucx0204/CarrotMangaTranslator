import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("workspace chrome CSS", () => {
  const shellCss = fs.readFileSync(
    path.join(ROOT, "src/renderer/src/styles/shell-workspace.css"),
    "utf8",
  );
  const stageCss = fs.readFileSync(
    path.join(ROOT, "src/renderer/src/styles/stage-overlay.css"),
    "utf8",
  );
  const foundationsCss = fs.readFileSync(
    path.join(ROOT, "src/renderer/src/styles/foundations.css"),
    "utf8",
  );

  it("locks fitted pages instead of creating an invisible scroll area", () => {
    expect(rule(shellCss, ".workspace.is-fit-scroll-locked")).toContain(
      "overflow: hidden",
    );
    expect(rule(stageCss, ".workspace-canvas-viewport")).not.toContain(
      "padding-right",
    );
    expect(stageCss).not.toContain("192px");
  });

  it("keeps the fit-mode icon visible through hover and focus states", () => {
    const interactiveRule = rule(
      shellCss,
      ".workspace-fit-select [data-ui-select-trigger]:hover,",
    );
    expect(interactiveRule).toContain("background: transparent");
    expect(interactiveRule).toContain("box-shadow: none");
    const fitTooltip = rule(
      shellCss,
      ".workspace-fit-picker.control-tooltip-bottom .control-tooltip-bubble",
    );
    expect(fitTooltip).toContain("right: 0");
    expect(fitTooltip).toContain("left: auto");
  });

  it("opens zoom controls as a horizontal flyout on the left", () => {
    const controls = rule(shellCss, ".workspace-view-controls");
    expect(controls).toContain("right: calc(100% + 8px)");
    expect(controls).toContain("flex-direction: row");
    expect(controls).toContain("width: max-content");
    expect(
      rule(
        shellCss,
        ".workspace-view-dock.open .workspace-view-reveal > .control-tooltip-bubble",
      ),
    ).toContain("display: none");
  });

  it("collapses sidebar contents while retaining both panel headers", () => {
    const collapsedPanels = rule(shellCss, ".library-panel.collapsed,");
    expect(collapsedPanels).toContain("flex: 0 0 auto");
    expect(collapsedPanels).not.toContain("display: none");
    expect(rule(shellCss, ".library-panel-content[hidden],")).toContain(
      "display: none",
    );
  });

  it("uses framed quick rails with subtle semantic group separators", () => {
    const frame = rule(shellCss, ".right-quick-controls-frame");
    expect(frame).toContain("border: 1px solid var(--border-soft)");
    expect(frame).toContain("border-radius: var(--r-md)");
    expect(
      rule(
        shellCss,
        ".right-quick-controls-frame:not(.collapsed) > .right-quick-rail-toggle::before",
      ),
    ).toContain("background: linear-gradient(");
    expect(
      rule(
        foundationsCss,
        ".stage-toolbar-section + .stage-toolbar-section::before",
      ),
    ).toContain("background: linear-gradient(");
  });

  it("moves the quick rail with a collapsible right panel track", () => {
    const shell = rule(shellCss, ".app-shell");
    expect(shell).toMatch(
      /grid-template-columns:\s*var\(--app-sidebar-width\)\s+minmax\(0, 1fr\)\s+var\(\s*--app-right-rail-track\s*\)/u,
    );
    expect(shell).toContain("transition: grid-template-columns 240ms");
    expect(rule(shellCss, ".app-shell:has(> .right-rail.is-hidden)")).toContain(
      "--app-right-rail-track: 0px",
    );
    expect(shellCss).toContain("width: var(--app-right-rail-width)");
    expect(shellCss).toContain("transform: translateX(0)");
    expect(rule(shellCss, ".right-rail.is-hidden {")).toContain(
      "transform: translateX(28px)",
    );
    expect(shellCss).toContain("justify-self: stretch");
    expect(shellCss).toContain("min-height: 640px");
    const rightToolbar = rule(shellCss, ".right-quick-rail");
    expect(rightToolbar).toContain("right: 10px");
    expect(rightToolbar).toContain("position: absolute");
  });
});

function rule(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`Missing CSS selector: ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  if (open < 0 || close < 0) {
    throw new Error(`Invalid CSS declaration block: ${selector}`);
  }
  return css.slice(open + 1, close);
}
