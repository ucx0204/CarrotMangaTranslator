import React from "react";
import { useTranslation } from "react-i18next";
import type {
  ChapterSnapshot,
  MangaPage,
} from "../../../../shared/libraryTypes";
import { toast } from "../../lib/toastStore";
import {
  buildTranslatedTextImport,
  decodeImportedTextContent,
  filterPagesByField,
  gatherText,
  type GatherScope,
  type TranslatedTextImportUpdate,
} from "../../lib/gatherText";
import { gatherTextGateway } from "./gatherTextGateway";

type TxtImportOptions = {
  chapter: ChapterSnapshot | null;
  page: MangaPage | null;
  scope: GatherScope;
  readingDirection: "ltr" | "rtl";
  onApplyTranslatedText?: (updates: TranslatedTextImportUpdate[]) => void;
  setReviewWarnings: (warnings: string[]) => void;
};

export function useTxtImportAction({
  chapter,
  page,
  scope,
  readingDirection,
  onApplyTranslatedText,
  setReviewWarnings,
}: TxtImportOptions): (file: File) => Promise<void> {
  const { t } = useTranslation("components");
  const { t: tRenderer } = useTranslation("renderer");
  return React.useCallback(
    async (file: File) => {
      if (!chapter || !onApplyTranslatedText) {
        return;
      }
      try {
        const result = buildTranslatedTextImport(
          filterPagesByField(
            gatherText({ chapter, page, scope, direction: readingDirection }),
            "translated",
          ),
          decodeImportedTextContent(await file.arrayBuffer()),
          tRenderer,
        );
        setReviewWarnings(result.warnings);
        if (!result.updates.length) {
          toast.info(
            result.matchedPageCount
              ? t("gatherText.importTxt.noChanges")
              : t("gatherText.importTxt.noApplicableText"),
          );
          return;
        }
        if (
          !window.confirm(
            t("gatherText.importTxt.confirm", { count: result.updates.length }),
          )
        ) {
          return;
        }
        onApplyTranslatedText(result.updates);
        toast.success(
          t("gatherText.importTxt.updated", { count: result.updates.length }),
        );
        if (result.warnings.length) {
          toast.info(
            t("gatherText.importTxt.warnings", {
              count: result.warnings.length,
            }),
          );
        }
      } catch (error) {
        console.error(error);
        toast.error(t("gatherText.importTxt.failed"));
      }
    },
    [
      chapter,
      onApplyTranslatedText,
      page,
      readingDirection,
      scope,
      setReviewWarnings,
      t,
      tRenderer,
    ],
  );
}

export function useGatherTextActions(
  text: string,
  defaultName: string,
): { handleCopy: () => Promise<void>; handleSave: () => Promise<void> } {
  const { t } = useTranslation("components");
  const handleCopy = React.useCallback(async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("gatherText.copySuccess"));
    } catch (_error) {
      toast.error(t("gatherText.copyFailed"));
    }
  }, [t, text]);

  const handleSave = React.useCallback(async () => {
    if (!text) return;
    try {
      const result = await gatherTextGateway.saveTextFile({
        defaultName,
        content: text,
      });
      if (result?.saved) toast.success(t("gatherText.saveSuccess"));
    } catch (_error) {
      toast.error(t("gatherText.saveFailed"));
    }
  }, [defaultName, t, text]);
  return { handleCopy, handleSave };
}

export function buildDefaultName(
  chapter: ChapterSnapshot | null,
  page: MangaPage | null,
  scope: GatherScope,
): string {
  const base = chapter?.title?.trim() || "manga-text";
  return scope === "page" && page ? `${base} - ${page.name}` : base;
}
