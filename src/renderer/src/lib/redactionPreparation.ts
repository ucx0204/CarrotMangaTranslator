import type { TFunction } from "i18next";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { OpenRedactionWorkspace } from "../../../shared/imageRedactionWorkspace";
import type { AppCommandMap } from "./appCommandTypes";

export type RedactionPreparationRequest = Exclude<
  OpenRedactionWorkspace,
  { kind: "job" }
>;
export type RedactionPreparationActions = {
  currentPageId: string | null;
  open: (request: RedactionPreparationRequest) => void;
};
export const REDACTION_PREPARATION_COMMANDS = [
  "prepare-redaction-page",
  "prepare-redaction-chapter",
  "prepare-redaction-work",
] as const;

export function redactionPreparationTarget(
  scope: "page" | "chapter" | "work",
  chapter: ChapterSnapshot | null,
  pageId: string | null,
): RedactionPreparationRequest | null {
  if (!chapter) return null;
  if (scope === "work") return { kind: "work", workId: chapter.workId };
  if (!chapter.pages.length) return null;
  if (scope === "chapter") return { kind: "chapter", chapterId: chapter.id };
  return pageId && chapter.pages.some((page) => page.id === pageId)
    ? { kind: "chapter", chapterId: chapter.id, pageIds: [pageId] }
    : null;
}

/** Preparation is local editing, available without an AI endpoint or a job. */
export function buildRedactionPreparationCommands(
  chapter: ChapterSnapshot | null,
  busy: boolean,
  actions: RedactionPreparationActions | undefined,
  t: TFunction<"components">,
): Pick<AppCommandMap, (typeof REDACTION_PREPARATION_COMMANDS)[number]> {
  const command = (scope: "page" | "chapter" | "work") => {
    const target = redactionPreparationTarget(
      scope,
      chapter,
      actions?.currentPageId ?? null,
    );
    const available = !busy && Boolean(target && actions);
    return {
      label: t(`manualRedaction.prepare_${scope}`),
      hint: t("manualRedaction.preparationHint"),
      paletteVisible: available,
      run: () => {
        if (available && target) actions?.open(target);
      },
    };
  };
  return {
    "prepare-redaction-page": {
      ...command("page"),
      id: "prepare-redaction-page",
    },
    "prepare-redaction-chapter": {
      ...command("chapter"),
      id: "prepare-redaction-chapter",
    },
    "prepare-redaction-work": {
      ...command("work"),
      id: "prepare-redaction-work",
    },
  };
}
