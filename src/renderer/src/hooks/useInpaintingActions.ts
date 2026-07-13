import type {
  InpaintingScope,
  UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";
import type { PageImageExportChapterSelection } from "../../../shared/pageImageExportTypes";
import { useDrawnPatternInpaintingAction } from "./useDrawnPatternInpaintingAction";
import { useExportPageImagesAction } from "./useExportPageImagesAction";
import { useRevertInpaintingAction } from "./useRevertInpaintingAction";
import { useRunInpaintingAction } from "./useRunInpaintingAction";
import { useRunInpaintingSelectionAction } from "./useRunInpaintingSelectionAction";
import type { AutoInpaintingChapterSelection } from "../lib/autoInpaintingSelection";

export function useInpaintingActions(options: UseInpaintingActionsOptions): {
  exportPageImages: (
    selections: PageImageExportChapterSelection[],
  ) => Promise<boolean>;
  revertInpainting: (scope: InpaintingScope) => Promise<void>;
  runDrawnPatternInpainting: () => Promise<void>;
  runInpainting: (scope: InpaintingScope) => Promise<void>;
  runInpaintingSelection: (
    selections: AutoInpaintingChapterSelection[],
  ) => Promise<void>;
} {
  const runInpainting = useRunInpaintingAction(options);
  const runDrawnPatternInpainting = useDrawnPatternInpaintingAction(options);
  const revertInpainting = useRevertInpaintingAction(options);
  const exportPageImages = useExportPageImagesAction(options);
  const runInpaintingSelection = useRunInpaintingSelectionAction(options);

  return {
    exportPageImages,
    revertInpainting,
    runDrawnPatternInpainting,
    runInpainting,
    runInpaintingSelection,
  };
}
