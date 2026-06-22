import { useInpaintingRetouchImpl } from "./useInpaintingRetouchImpl";
import type {
  InpaintingRetouchResult,
  UseInpaintingRetouchOptions,
} from "./inpaintingRetouchTypes";

export type {
  InpaintingRetouchResult,
  RetouchApplyTool,
  RetouchDrawTool,
  RetouchHistoryEntry,
  RetouchPoint,
  RetouchPreviewState,
  UseInpaintingRetouchOptions,
} from "./inpaintingRetouchTypes";

export function useInpaintingRetouch(
  options: UseInpaintingRetouchOptions,
): InpaintingRetouchResult {
  return useInpaintingRetouchImpl(options);
}
