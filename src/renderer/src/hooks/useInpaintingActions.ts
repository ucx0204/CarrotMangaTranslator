import type {
  InpaintingScope,
  UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";
import type { InpaintingPostprocessOptions } from "../../../shared/inpaintingTypes";
import type { PageImageExportChapterSelection } from "../../../shared/pageImageExportTypes";
import { useDrawnPatternInpaintingAction } from "./useDrawnPatternInpaintingAction";
import { useExportPageImagesAction } from "./useExportPageImagesAction";
import { useRevertInpaintingAction } from "./useRevertInpaintingAction";
import { useRunBubbleLayoutAction } from "./useRunBubbleLayoutAction";
import { useRunInpaintingAction } from "./useRunInpaintingAction";
import { useRunInpaintingSelectionAction } from "./useRunInpaintingSelectionAction";
import type { AutoInpaintingChapterSelection } from "../lib/autoInpaintingSelection";
import { useCallback, useEffect, useRef, useState } from "react";

type InpaintingActions = {
  actionBusy: boolean;
  exportPageImages: (
    selections: PageImageExportChapterSelection[],
  ) => Promise<boolean>;
  revertInpainting: (scope: InpaintingScope) => Promise<void>;
  runBubbleLayout: () => Promise<void>;
  runDrawnPatternInpainting: () => Promise<void>;
  runInpainting: (scope: InpaintingScope) => Promise<void>;
  runInpaintingSelection: (
    selections: AutoInpaintingChapterSelection[],
    postprocess?: InpaintingPostprocessOptions,
  ) => Promise<void>;
};

export function useInpaintingActions(
  options: UseInpaintingActionsOptions,
): InpaintingActions {
  const refreshLibrary = useSerializedLibraryRefresh(options.refreshLibrary);
  const queuedOptions = { ...options, refreshLibrary };
  const rawActions = {
    runBubbleLayout: useRunBubbleLayoutAction(queuedOptions),
    runInpainting: useRunInpaintingAction(queuedOptions),
    runDrawnPatternInpainting: useDrawnPatternInpaintingAction(queuedOptions),
    revertInpainting: useRevertInpaintingAction(queuedOptions),
    runInpaintingSelection: useRunInpaintingSelectionAction(queuedOptions),
  };
  const exclusive = useExclusiveImageActions(rawActions);
  const exportPageImages = useExportPageImagesAction(options);

  return {
    ...exclusive,
    exportPageImages,
  };
}

function useSerializedLibraryRefresh(
  refreshLibrary: () => Promise<void>,
): () => Promise<void> {
  const refreshRef = useRef(refreshLibrary);
  const tailRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    refreshRef.current = refreshLibrary;
  }, [refreshLibrary]);
  return useCallback(() => {
    const run = (): Promise<void> => refreshRef.current();
    const scheduled = tailRef.current.then(run, run);
    tailRef.current = scheduled;
    return scheduled;
  }, []);
}

function useExclusiveImageActions(
  actions: Omit<InpaintingActions, "actionBusy" | "exportPageImages">,
): Omit<InpaintingActions, "exportPageImages"> {
  const busyRef = useRef(false);
  const [actionBusy, setActionBusy] = useState(false);
  const runExclusive = useCallback(async (run: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setActionBusy(true);
    try {
      await run();
    } finally {
      busyRef.current = false;
      setActionBusy(false);
    }
  }, []);
  const runInpainting = useCallback(
    (scope: InpaintingScope) =>
      runExclusive(() => actions.runInpainting(scope)),
    [actions, runExclusive],
  );
  const runDrawnPatternInpainting = useCallback(
    () => runExclusive(actions.runDrawnPatternInpainting),
    [actions, runExclusive],
  );
  const runBubbleLayout = useCallback(
    () => runExclusive(actions.runBubbleLayout),
    [actions, runExclusive],
  );
  const revertInpainting = useCallback(
    (scope: InpaintingScope) =>
      runExclusive(() => actions.revertInpainting(scope)),
    [actions, runExclusive],
  );
  const runInpaintingSelection = useCallback(
    (
      selections: AutoInpaintingChapterSelection[],
      postprocess?: InpaintingPostprocessOptions,
    ) =>
      runExclusive(() =>
        actions.runInpaintingSelection(selections, postprocess),
      ),
    [actions, runExclusive],
  );
  return {
    actionBusy,
    revertInpainting,
    runBubbleLayout,
    runDrawnPatternInpainting,
    runInpainting,
    runInpaintingSelection,
  };
}
