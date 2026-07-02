/**
 * Workspace stage interaction tools, switched from the small vertical toolbar
 * docked at the left edge of the workspace.
 *
 * - "select": default behavior — click/drag text blocks, click empty space to
 *   deselect.
 * - "block": drag on the image to create a new text block.
 * - "hand": drag anywhere (blocks ignore the pointer) to pan the workspace.
 */
export type StageTool = "select" | "block" | "hand";
