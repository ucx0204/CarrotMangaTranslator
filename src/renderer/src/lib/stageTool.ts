/**
 * Workspace interaction tools, switched from the small vertical toolbar
 * docked at the left edge of the canvas.
 *
 * - "select": default behavior — click/drag text blocks, click empty space to
 *   deselect.
 * - "block": drag on the image to create a new text block.
 * - "hand": drag anywhere (blocks ignore the pointer) to pan the workspace.
 * - "mask": paint a mask which can be sent to the inpainting engine.
 * - "brush": paint directly on the current inpainting result.
 * - "eraser": restore the underlying image below retouch strokes.
 * - "picker": sample a brush colour from the canvas.
 */
export type WorkspaceTool =
  | "select"
  | "block"
  | "hand"
  | "mask"
  | "brush"
  | "eraser"
  | "picker";

/** Backwards-compatible name used by existing stage interaction helpers. */
export type StageTool = WorkspaceTool;

export type RetouchTool = Extract<
  WorkspaceTool,
  "mask" | "brush" | "eraser" | "picker"
>;

export function isRetouchTool(tool: WorkspaceTool): tool is RetouchTool {
  return (
    tool === "mask" ||
    tool === "brush" ||
    tool === "eraser" ||
    tool === "picker"
  );
}

export function isSizableRetouchTool(
  tool: WorkspaceTool,
): tool is Exclude<RetouchTool, "picker"> {
  return tool === "mask" || tool === "brush" || tool === "eraser";
}
