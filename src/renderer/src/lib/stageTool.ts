/**
 * Workspace interaction tools, switched from the small vertical toolbar
 * docked at the left edge of the canvas.
 *
 * - "select": default behavior — click/drag text blocks, click empty space to
 *   deselect.
 * - "block": drag on the image to create a new text block.
 * - "hand": drag anywhere (blocks ignore the pointer) to pan the workspace.
 * - "perspective": select/move blocks and edit their four-corner transform.
 * - "curve": select/move blocks and edit an enabled curve text path.
 * - "mask": paint a mask which can be sent to the inpainting engine.
 * - "brush": paint directly on the current inpainting result.
 * - "rectangle": drag a filled rectangle onto the current inpainting result.
 * - "ellipse": drag a filled ellipse onto the current inpainting result.
 * - "eraser": restore the underlying image below retouch strokes.
 * - "picker": sample a brush colour from the canvas.
 */
export type WorkspaceTool =
  | "select"
  | "block"
  | "hand"
  | "perspective"
  | "curve"
  | "mask"
  | "brush"
  | "rectangle"
  | "ellipse"
  | "eraser"
  | "picker";

/** Backwards-compatible name used by existing stage interaction helpers. */
export type StageTool = WorkspaceTool;

export type RetouchTool = Extract<
  WorkspaceTool,
  "mask" | "brush" | "rectangle" | "ellipse" | "eraser" | "picker"
>;

export function isRetouchTool(tool: WorkspaceTool): tool is RetouchTool {
  return (
    tool === "mask" ||
    tool === "brush" ||
    tool === "rectangle" ||
    tool === "ellipse" ||
    tool === "eraser" ||
    tool === "picker"
  );
}

export type BlockEditingTool = Extract<
  WorkspaceTool,
  "select" | "perspective" | "curve"
>;

export function isBlockEditingTool(
  tool: WorkspaceTool,
): tool is BlockEditingTool {
  return tool === "select" || tool === "perspective" || tool === "curve";
}

export function isSizableRetouchTool(
  tool: WorkspaceTool,
): tool is Extract<RetouchTool, "mask" | "brush" | "eraser"> {
  return tool === "mask" || tool === "brush" || tool === "eraser";
}

export function isPaintColorRetouchTool(
  tool: WorkspaceTool,
): tool is Extract<RetouchTool, "brush" | "rectangle" | "ellipse"> {
  return tool === "brush" || tool === "rectangle" || tool === "ellipse";
}
