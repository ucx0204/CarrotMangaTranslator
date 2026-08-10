import type {
  InpaintingScope,
  UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";
import type { InpaintingPostprocessOptions } from "../../../shared/inpaintingTypes";
import type { PageImageExportChapterSelection } from "../../../shared/pageImageExportTypes";
import type { PageJobTargetSnapshot } from "../../../shared/pageRevision";
import { useDrawnPatternInpaintingAction } from "./useDrawnPatternInpaintingAction";
import { useExportPageImagesAction } from "./useExportPageImagesAction";
import { useRevertInpaintingAction } from "./useRevertInpaintingAction";
import { useRunBubbleLayoutAction } from "./useRunBubbleLayoutAction";
import { useRunInpaintingAction } from "./useRunInpaintingAction";
import { useRunInpaintingSelectionAction } from "./useRunInpaintingSelectionAction";
import type { AutoInpaintingChapterSelection } from "../lib/autoInpaintingSelection";
import { useCallback, useEffect, useRef, useState } from "react";

export type InpaintingActions = {
  actionBusy: boolean;
  exportPageImages: (
    selections: PageImageExportChapterSelection[],
    expectedTargets?: PageJobTargetSnapshot[],
    options?: { omitText?: boolean },
  ) => Promise<boolean>;
  revertInpainting: (scope: InpaintingScope) => Promise<void>;
  runBubbleLayout: (blockId?: string) => Promise<void>;
  runDrawnPatternInpainting: () => Promise<void>;
  runInpainting: (scope: InpaintingScope, blockId?: string) => Promise<void>;
  runInpaintingSelection: (
    selections: AutoInpaintingChapterSelection[],
    postprocess?: InpaintingPostprocessOptions,
  ) => Promise<void>;
};

export function useInpaintingActions(
  options: UseInpaintingActionsOptions,
): InpaintingActions {
  const refreshLibrary = useSerializedLibraryRefresh(options.refreshLibrary);
  const baseOptions = { ...options, refreshLibrary };
  const rawActions = {
    runBubbleLayout: useRunBubbleLayoutAction(baseOptions),
    runInpainting: useRunInpaintingAction(baseOptions),
    runDrawnPatternInpainting: useDrawnPatternInpaintingAction(baseOptions),
    revertInpainting: useRevertInpaintingAction(baseOptions),
    runInpaintingSelection: useRunInpaintingSelectionAction(baseOptions),
  };
  const exclusive = useExclusiveImageActions(rawActions);
  const exportPageImages = useExportPageImagesAction(options);

  return {
    ...exclusive,
    actionBusy: exclusive.actionBusy,
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
  actions: Pick<
    InpaintingActions,
    | "runBubbleLayout"
    | "runInpainting"
    | "runDrawnPatternInpainting"
    | "revertInpainting"
    | "runInpaintingSelection"
  >,
): Pick<
  InpaintingActions,
  | "actionBusy"
  | "runBubbleLayout"
  | "runInpainting"
  | "runDrawnPatternInpainting"
  | "revertInpainting"
  | "runInpaintingSelection"
> {
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
    (scope: InpaintingScope, blockId?: string) =>
      runExclusive(() => actions.runInpainting(scope, blockId)),
    [actions, runExclusive],
  );
  const runDrawnPatternInpainting = useCallback(
    () => runExclusive(actions.runDrawnPatternInpainting),
    [actions, runExclusive],
  );
  const runBubbleLayout = useCallback(
    (blockId?: string) => runExclusive(() => actions.runBubbleLayout(blockId)),
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
