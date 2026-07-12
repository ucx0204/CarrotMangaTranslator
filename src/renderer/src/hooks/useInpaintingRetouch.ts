import { useInpaintingRetouchImpl } from "./useInpaintingRetouchImpl";
import type {
  InpaintingRetouchResult,
  UseInpaintingRetouchOptions,
} from "./inpaintingRetouchTypes";

export type {
  InpaintingRetouchResult,
  RetouchPreviewState,
  UseInpaintingRetouchOptions,
} from "./inpaintingRetouchTypes";

export function useInpaintingRetouch(
  options: UseInpaintingRetouchOptions,
): InpaintingRetouchResult {
  return useInpaintingRetouchImpl(options);
}
