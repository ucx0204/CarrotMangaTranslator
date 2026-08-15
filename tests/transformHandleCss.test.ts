import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  resolve(process.cwd(), "src/renderer/src/components/overlayTransforms.css"),
  "utf8",
);
const stageStylesheet = readFileSync(
  resolve(process.cwd(), "src/renderer/src/styles/stage-overlay.css"),
  "utf8",
);

describe("transform handle presentation", () => {
  it("keeps a 24px pointer target around a viewport-responsive marker", () => {
    const hitArea = declarationBlock(stylesheet, ".transform-handle");
    const marker = declarationBlock(stylesheet, ".transform-handle::after");

    expect(hitArea).toMatch(/width:\s*24px;/);
    expect(hitArea).toMatch(/height:\s*24px;/);
    expect(hitArea).toMatch(/margin:\s*-12px 0 0 -12px;/);
    expect(marker).toMatch(/width:\s*0\.5vmin;/);
    expect(marker).toMatch(/height:\s*0\.5vmin;/);
  });

  it("keeps the full hit target transparent on hover, active, and focus", () => {
    const interactionStates = declarationBlock(
      stylesheet,
      ".transform-handle:hover:not(:disabled),\n.transform-handle:active:not(:disabled),\n.transform-handle:focus-visible",
    );

    expect(interactionStates).toMatch(/border:\s*0;/);
    expect(interactionStates).toMatch(/background:\s*transparent;/);
    expect(interactionStates).toMatch(/box-shadow:\s*none;/);
    expect(interactionStates).toMatch(/outline:\s*0;/);
  });

  it("does not enlarge or ring markers on hover, focus, or selection", () => {
    expect(stylesheet).not.toMatch(/\.transform-handle:hover[^,{]*::after/);
    expect(stylesheet).not.toMatch(
      /\.transform-handle:focus-visible[^,{]*::after/,
    );

    for (const selector of [
      ".rotation-handle::after",
      ".curve-controls .transform-handle::after",
      ".warp-controls .warp-point::after",
      ".warp-controls .warp-point.selected::after",
    ]) {
      expect(declarationBlock(stylesheet, selector)).not.toMatch(
        /(?:width|height|box-shadow):/,
      );
    }
  });

  it("retains transform cursors and uses the block outline for focus context", () => {
    expect(declarationBlock(stylesheet, ".resize-nw")).toMatch(
      /cursor:\s*nwse-resize;/,
    );
    expect(declarationBlock(stylesheet, ".resize-n")).toMatch(
      /cursor:\s*ns-resize;/,
    );
    expect(declarationBlock(stylesheet, ".resize-ne")).toMatch(
      /cursor:\s*nesw-resize;/,
    );
    expect(declarationBlock(stylesheet, ".resize-e")).toMatch(
      /cursor:\s*ew-resize;/,
    );
    expect(declarationBlock(stylesheet, ".rotation-handle")).toMatch(
      /cursor:\s*url\("\.\.\/assets\/cursors\/tabler-rotate-clockwise\.svg"\) 12 12,\s*crosshair;/,
    );
    expect(
      existsSync(
        resolve(
          process.cwd(),
          "src/renderer/src/assets/cursors/tabler-rotate-clockwise.svg",
        ),
      ),
    ).toBe(true);
    expect(declarationBlock(stylesheet, ".transform-handle")).toMatch(
      /outline:\s*0;/,
    );
    expect(
      declarationBlock(stageStylesheet, ".overlay-block.selected"),
    ).toMatch(/outline:\s*2px solid var\(--accent-bd\);/);
    const transformSelection = declarationBlock(
      stylesheet,
      ".overlay-block.transform-mode-select.selected",
    );
    expect(transformSelection).toMatch(/outline:\s*1px solid #58b9ff;/);
    expect(transformSelection).toMatch(/outline-offset:\s*0;/);
  });
});

function declarationBlock(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const selectorIndex = source.search(new RegExp(`${escapedSelector}\\s*\\{`));
  if (selectorIndex < 0) {
    throw new Error(`Missing CSS selector: ${selector}`);
  }
  const start = source.indexOf("{", selectorIndex);
  const end = source.indexOf("}", start);
  if (start < 0 || end < 0) {
    throw new Error(`Invalid CSS declaration block: ${selector}`);
  }
  return source.slice(start + 1, end);
}
