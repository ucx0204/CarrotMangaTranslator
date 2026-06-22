import type {
  InpaintingScope,
  UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";
import { useDrawnPatternInpaintingAction } from "./useDrawnPatternInpaintingAction";
import { useExportInpaintingResultsAction } from "./useExportInpaintingResultsAction";
import { useInpaintingModeActions } from "./useInpaintingModeActions";
import { useRevertInpaintingAction } from "./useRevertInpaintingAction";
import { useRunInpaintingAction } from "./useRunInpaintingAction";

export function useInpaintingActions(options: UseInpaintingActionsOptions): {
  enterInpaintingMode: () => Promise<void>;
  exitInpaintingMode: () => void;
  exportInpaintingResults: (scope: InpaintingScope) => Promise<void>;
  revertInpainting: (scope: InpaintingScope) => Promise<void>;
  runDrawnPatternInpainting: () => Promise<void>;
  runInpainting: (scope: InpaintingScope) => Promise<void>;
} {
  const modeActions = useInpaintingModeActions(options);
  const runInpainting = useRunInpaintingAction(options);
  const runDrawnPatternInpainting = useDrawnPatternInpaintingAction(options);
  const revertInpainting = useRevertInpaintingAction(options);
  const exportInpaintingResults = useExportInpaintingResultsAction(options);

  return {
    ...modeActions,
    exportInpaintingResults,
    revertInpainting,
    runDrawnPatternInpainting,
    runInpainting,
  };
}
