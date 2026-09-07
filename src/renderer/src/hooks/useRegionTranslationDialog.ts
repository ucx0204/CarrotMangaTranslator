import { handoffActiveModalToWorkCenter } from "../lib/modalWorkCenterHandoff";
import { canUseCodexTypesetting } from "../../../shared/codexCapabilities";
import { useCodexConnection } from "./useCodexConnection";
import { useRegionTextReview } from "./useRegionTextReview";
import { useEffect, useRef, useState } from "react";
import { isUsableRegionBbox } from "../../../shared/region";
import { buildRegionTranslationRequest } from "../lib/regionTranslationOptions";
import type { BBox } from "../../../shared/textTypes";
import type {
  RegionTranslationChoices,
  RegionTranslationDialog,
} from "../lib/regionTranslationOptions";
import type { RegionAnalysisRequest } from "../../../shared/analysisTypes";
import type { UseTranslationActionsOptions } from "./translationActionTypes";

export function useRegionTranslationDialog(
  options: UseTranslationActionsOptions,
  execute: (
    bbox: BBox,
    request?: Partial<RegionAnalysisRequest>,
  ) => Promise<boolean>,
) {
  const textReview = useRegionTextReview();
  const { selection, setSelection, imageAvailable, open } = useRegionSelection(
    options,
    textReview.cancel,
  );
  const bbox = selection?.bbox ?? null;
  const delegateAll = options.codexDelegationActive === true;
  const setBbox = () =>
    setSelection((current) => (current?.bbox === bbox ? null : current));
  const [remembered, setRemembered] = useState(
    new Map<string, RegionTranslationChoices>(),
  );
  const run = useRegionTranslationRun({
    bbox,
    options,
    execute,
    textReview,
    delegated: selection?.delegated,
    close: setBbox,
    imageAvailable,
    submitted: () =>
      setSelection((current) =>
        current?.bbox === bbox ? { ...current, started: true } : current,
      ),
    completed: (choices) =>
      setRemembered((previous) =>
        new Map(previous).set(delegateAll ? "codex" : "standard", choices),
      ),
  });
  const dialog: RegionTranslationDialog | null =
    bbox && selection && (!selection.started || textReview.review)
      ? {
          bbox,
          page: selection.page,
          codexImageAvailable: imageAvailable,
          codexDelegateAll: delegateAll,
          initial: remembered.get(delegateAll ? "codex" : "standard") ?? {
            output: "text",
            eraseOriginal: false,
          },
          onRun: run,
          busy: textReview.busy,
          unavailable: options.codexUnavailable,
          error: textReview.error,
          review: textReview.review,
          onConfirm: (translations) => {
            if (!imageAvailable) return;
            void textReview.confirm(translations, () => {
              handoffActiveModalToWorkCenter();
              setBbox();
            });
          },
          onClose: () => {
            textReview.cancel();
            setBbox();
          },
        }
      : null;
  return { open, dialog };
}

function useRegionSelection(
  options: UseTranslationActionsOptions,
  cancelReview: () => void,
) {
  const [selection, setSelection] = useState<{
    bbox: BBox;
    delegated: boolean;
    page: NonNullable<UseTranslationActionsOptions["selectedPage"]>;
    started: boolean;
  } | null>(null);
  const { account } = useCodexConnection(Boolean(selection));
  const delegateAll = options.codexDelegationActive === true;
  const imageAvailable = delegateAll
    ? !options.codexUnavailable
    : canUseCodexTypesetting(options.settings ?? null, account, true);
  const started = selection?.started === true;
  useEffect(() => {
    if (started) return;
    cancelReview();
    setSelection(null);
  }, [
    options.selectedPage?.id,
    options.currentChapter?.id,
    options.codexDelegationActive,
    cancelReview,
    started,
  ]);
  const open = async (next: BBox): Promise<void> => {
    if (
      !options.selectedPage ||
      selection?.started ||
      options.jobActive ||
      options.codexUnavailable ||
      !isUsableRegionBbox(next, 10)
    )
      return;
    setSelection({
      bbox: next,
      delegated: delegateAll,
      page: options.selectedPage,
      started: false,
    });
  };
  return { selection, setSelection, imageAvailable, open };
}

function useRegionTranslationRun({
  bbox,
  options,
  execute,
  textReview,
  delegated,
  close,
  imageAvailable,
  submitted,
  completed: onCompleted,
}: {
  bbox: BBox | null;
  options: UseTranslationActionsOptions;
  execute: Parameters<typeof useRegionTranslationDialog>[1];
  textReview: ReturnType<typeof useRegionTextReview>;
  delegated: boolean | undefined;
  close: () => void;
  imageAvailable: boolean;
  submitted: () => void;
  completed: (choices: RegionTranslationChoices) => void;
}) {
  const inFlight = useRef(false);
  const delegateAll = options.codexDelegationActive === true;
  const run = (choices: RegionTranslationChoices) => {
    if (
      !bbox ||
      inFlight.current ||
      options.jobActive ||
      options.codexUnavailable ||
      (choices.output === "image" && !imageAvailable) ||
      delegated !== delegateAll
    )
      return;
    const selected = bbox;
    const needsReview = choices.output === "image";
    const textReviewSessionId = needsReview ? textReview.begin() : undefined;
    handoffActiveModalToWorkCenter();
    if (needsReview) submitted();
    else close();
    inFlight.current = true;
    void execute(selected, {
      ...buildRegionTranslationRequest(options.settings, choices, delegateAll),
      ...(textReviewSessionId ? { textReviewSessionId } : {}),
    })
      .then((completed) => {
        if (needsReview) textReview.finish(completed);
        close();
        if (completed) onCompleted(choices);
      })
      .finally(() => {
        inFlight.current = false;
      });
  };
  return run;
}
