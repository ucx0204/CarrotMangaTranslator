import React from "react";
import {
  filterPagesByField,
  formatGatheredText,
  gatherText,
  type GatherField,
  type GatherScope,
} from "../../lib/gatherText";
import { useGatherTextSearch } from "../../hooks/useGatherTextSearch";
import type { GatherTextModalProps } from "./gatherTextTypes";
import {
  buildDefaultName,
  useGatherTextActions,
  useTxtImportAction,
} from "./useGatherTextFileActions";
import { useReviewTextActions } from "./useReviewTextActions";

export function useGatherTextModalModel({
  chapter,
  page,
  onChapterUpdated,
  onApplyTranslatedText,
  readingDirection = "rtl",
}: Pick<
  GatherTextModalProps,
  | "chapter"
  | "page"
  | "onChapterUpdated"
  | "onApplyTranslatedText"
  | "readingDirection"
>) {
  const [scope, setScope] = React.useState<GatherScope>("page");
  const [field, setField] = React.useState<GatherField>("both");
  const [excludeHeaders, setExcludeHeaders] = React.useState(false);
  const [reviewWarnings, setReviewWarnings] = React.useState<string[]>([]);
  const [reviewBusy, setReviewBusy] = React.useState(false);
  const reviewFileInputRef = React.useRef<HTMLInputElement | null>(null);
  const txtFileInputRef = React.useRef<HTMLInputElement | null>(null);
  const pages = React.useMemo(
    () =>
      filterPagesByField(
        gatherText({ chapter, page, scope, direction: readingDirection }),
        field,
      ),
    [chapter, field, page, readingDirection, scope],
  );
  const text = React.useMemo(
    () => formatGatheredText(pages, field, !excludeHeaders),
    [excludeHeaders, field, pages],
  );
  const fileActions = useGatherTextActions(
    text,
    buildDefaultName(chapter, page, scope),
  );
  const reviewActions = useReviewTextActions({
    chapter,
    onChapterUpdated,
    setReviewBusy,
    setReviewWarnings,
  });
  const handleImportTxtFile = useTxtImportAction({
    chapter,
    page,
    scope,
    readingDirection,
    onApplyTranslatedText,
    setReviewWarnings,
  });
  return {
    scope,
    setScope,
    field,
    setField,
    excludeHeaders,
    setExcludeHeaders,
    reviewWarnings,
    reviewBusy,
    reviewFileInputRef,
    txtFileInputRef,
    pages,
    hasContent: pages.length > 0,
    search: useGatherTextSearch(pages, field),
    handleImportTxtFile,
    ...fileActions,
    ...reviewActions,
  };
}
