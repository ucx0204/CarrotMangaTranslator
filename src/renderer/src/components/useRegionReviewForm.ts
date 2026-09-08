import React from "react";
import {
  emptyHistory,
  reviewHistory,
  type EditAction,
} from "../lib/regionReviewHistory";
import { paintedSelectionBounds } from "../lib/regionReviewSelection";
import type { BBox } from "../../../shared/textTypes";
import type { LetteringMaskStroke } from "../../../shared/generatedLetteringMaskTypes";
import type { RegionTranslationDialog } from "../lib/regionTranslationOptions";
import { prepareRegionReviewProtection } from "../lib/regionReviewProtection";
import { normalizedRegionToPixelRect } from "../../../shared/region";

export type RegionReviewValue = {
  regionId: string;
  text: string;
  sourceBbox: BBox;
  sourceText?: string;
  parentRegionId?: string;
  styleGroupId: string;
  selectionStrokes?: LetteringMaskStroke[];
  exclusionStrokes?: LetteringMaskStroke[];
};
function initialReviewValues(review: RegionTranslationDialog["review"]) {
  return (
    review?.regions.map((region) => ({
      regionId: region.id,
      text: region.translatedText,
      sourceBbox: region.sourceBbox,
      sourceText: region.sourceText,
      styleGroupId: region.styleGroupId ?? region.id,
    })) ?? []
  );
}

export function useRegionReviewForm(props: RegionTranslationDialog) {
  const [values, setValues] = React.useState<RegionReviewValue[]>([]);
  const [focused, setFocused] = React.useState<string>();
  const [history, dispatch] = React.useReducer(reviewHistory, emptyHistory());
  const { boxes } = history.present;
  const strokes = history.present.exclusions[focused ?? ""] ?? [];
  const resolvedValues = resolveReviewValues(values, history.present);
  const [preparing, setPreparing] = React.useState(false);
  const [error, setError] = React.useState("");
  const alive = React.useRef(true);
  const submitting = React.useRef(false);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useInitializeReview(props.review, setValues, setFocused, dispatch, setError);
  const update = reviewUpdater(dispatch, setValues);
  const confirm = useReviewConfirm(
    props,
    resolvedValues,
    alive,
    submitting,
    setPreparing,
    setError,
  );
  return {
    values: resolvedValues,
    focused,
    setFocused,
    strokes,
    update,
    preparing,
    error,
    confirm,
    valid: reviewValuesValid(props, resolvedValues),
    addPaintStroke: reviewPaintAdder(
      props,
      resolvedValues,
      focused,
      setValues,
      dispatch,
      setFocused,
    ),
    addRegion: reviewRegionAdder(
      props,
      resolvedValues,
      focused,
      setValues,
      dispatch,
      setFocused,
    ),
    removeRegion: () => {
      if (!focused || resolvedValues.length <= 1) return;
      dispatch({ type: "remove", id: focused });
      setFocused(
        resolvedValues.find((value) => value.regionId !== focused)?.regionId,
      );
    },
    addStroke: (stroke: LetteringMaskStroke, id = focused) => {
      if (id && boxes[id]) dispatch({ type: "stroke", id, stroke });
    },
    beginGesture: () => dispatch({ type: "begin" }),
    endGesture: () => dispatch({ type: "end" }),
    cancelGesture: () => dispatch({ type: "cancel" }),
    undo: () => dispatch({ type: "undo" }),
    redo: () => dispatch({ type: "redo" }),
    canUndo: !!history.past.length,
    canRedo: !!history.future.length,
  };
}

function reviewValuesValid(
  props: RegionTranslationDialog,
  values: RegionReviewValue[],
) {
  return (
    !!props.review &&
    values.length > 0 &&
    values.every((value) => value.text.trim())
  );
}

function useReviewConfirm(
  props: RegionTranslationDialog,
  values: RegionReviewValue[],
  alive: React.RefObject<boolean>,
  submitting: React.RefObject<boolean>,
  setPreparing: (value: boolean) => void,
  setError: (value: string) => void,
) {
  const confirm = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setPreparing(true);
    setError("");
    try {
      const protection = await prepareRegionReviewProtection(
        [],
        normalizedRegionToPixelRect(props.bbox, props.page, 8),
        values,
      );
      const excluded =
        props.review?.regions
          .filter(
            (region) => !values.some((value) => value.regionId === region.id),
          )
          .map((region) => ({
            regionId: region.id,
            text: region.translatedText,
            excluded: true,
          })) ?? [];
      const submitted = values.map((value) => ({
        regionId: value.regionId,
        text: value.text,
        sourceBbox: value.sourceBbox,
        parentRegionId: value.parentRegionId,
        sourceText: value.sourceText,
        styleGroupId: value.styleGroupId,
      }));
      if (alive.current)
        props.onConfirm?.([...submitted, ...excluded], protection);
    } catch (failure) {
      if (alive.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      submitting.current = false;
      if (alive.current) setPreparing(false);
    }
  };
  return confirm;
}

function reviewRegionAdder(
  props: RegionTranslationDialog,
  resolvedValues: RegionReviewValue[],
  focused: string | undefined,
  setValues: React.Dispatch<React.SetStateAction<RegionReviewValue[]>>,
  dispatch: React.Dispatch<EditAction>,
  setFocused: (id: string) => void,
) {
  return (box: BBox) => {
    if (resolvedValues.length >= 128) return;
    const parent =
      props.review?.regions.find((region) => region.id === focused) ??
      props.review?.regions[0];
    if (!parent) return;
    const id = crypto.randomUUID();
    setValues((previous) => [
      ...previous,
      {
        regionId: id,
        parentRegionId: parent.id,
        sourceText: "",
        text: "",
        sourceBbox: box,
        styleGroupId: id,
      },
    ]);
    dispatch({ type: "box", id, box });
    setFocused(id);
  };
}

function reviewPaintAdder(
  props: RegionTranslationDialog,
  values: RegionReviewValue[],
  focused: string | undefined,
  setValues: React.Dispatch<React.SetStateAction<RegionReviewValue[]>>,
  dispatch: React.Dispatch<EditAction>,
  setFocused: (id: string) => void,
) {
  return (stroke: LetteringMaskStroke, target = focused) => {
    const current = values.find((value) => value.regionId === target);
    const id = current?.regionId ?? crypto.randomUUID();
    if (!current) {
      if (values.length >= 128 || !props.review) return;
      setValues((previous) => [
        ...previous,
        {
          regionId: id,
          parentRegionId: props.review?.regions[0]?.id,
          text: "",
          sourceText: "",
          sourceBbox: paintedSelectionBounds([stroke]),
          styleGroupId: id,
        },
      ]);
    }
    dispatch({ type: "paint", id, stroke });
    setFocused(id);
  };
}

function useInitializeReview(
  review: RegionTranslationDialog["review"],
  setValues: React.Dispatch<React.SetStateAction<RegionReviewValue[]>>,
  setFocused: (id: string | undefined) => void,
  dispatch: React.Dispatch<EditAction>,
  setError: (error: string) => void,
) {
  React.useEffect(() => {
    setValues(initialReviewValues(review));
    setFocused(review?.regions[0]?.id);
    dispatch({
      type: "reset",
      boxes: Object.fromEntries(
        review?.regions.map((region) => [region.id, region.sourceBbox]) ?? [],
      ),
    });
    setError("");
  }, [review, setValues, setFocused, dispatch, setError]);
}

function reviewUpdater(
  dispatch: React.Dispatch<EditAction>,
  setValues: React.Dispatch<React.SetStateAction<RegionReviewValue[]>>,
) {
  return (id: string, patch: Partial<RegionReviewValue>) => {
    if (patch.sourceBbox) dispatch({ type: "box", id, box: patch.sourceBbox });
    if (patch.styleGroupId)
      dispatch({ type: "group", id, group: patch.styleGroupId });
    if (patch.text !== undefined)
      setValues((previous) =>
        previous.map((value) =>
          value.regionId === id
            ? { ...value, text: patch.text ?? value.text }
            : value,
        ),
      );
  };
}

function resolveReviewValues(
  values: RegionReviewValue[],
  snapshot: ReturnType<typeof emptyHistory>["present"],
) {
  return values
    .filter((value) => snapshot.boxes[value.regionId])
    .map((value) => ({
      ...value,
      selectionStrokes: snapshot.selections[value.regionId],
      exclusionStrokes: snapshot.exclusions[value.regionId],
      sourceBbox: snapshot.boxes[value.regionId] ?? value.sourceBbox,
      styleGroupId: snapshot.groups[value.regionId] ?? value.styleGroupId,
    }));
}
