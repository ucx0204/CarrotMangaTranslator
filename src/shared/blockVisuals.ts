import type { BlockType } from "./textTypes";
import { normalizeBlockType } from "./geometry";

export type BlockVisualStyle = {
  borderColor: string;
  backgroundColor: string;
  defaultOpacity: number;
};

const BLOCK_VISUAL_STYLES: Record<BlockType, BlockVisualStyle> = {
  nonsolid: {
    borderColor: "#f59e0b",
    backgroundColor: "#fef3c7",
    defaultOpacity: 0.7,
  },
};

export function resolveBlockVisualStyle(type: unknown): BlockVisualStyle {
  return BLOCK_VISUAL_STYLES[normalizeBlockType(type)];
}
