import type { BlockType } from "./types";
import { normalizeBlockType } from "./geometry";

export type BlockVisualStyle = {
  borderColor: string;
  backgroundColor: string;
  defaultOpacity: number;
};

export const BLOCK_VISUAL_STYLES: Record<BlockType, BlockVisualStyle> = {
  nonsolid: {
    borderColor: "#f59e0b",
    backgroundColor: "#fef3c7",
    defaultOpacity: 0.5
  }
};

export function resolveBlockVisualStyle(type: unknown): BlockVisualStyle {
  return BLOCK_VISUAL_STYLES[normalizeBlockType(type)];
}
