import type { TFunction } from "i18next";
import type { MangaPage } from "../../../../shared/libraryTypes";
import { isPageFullyCompleted } from "../../../../shared/pageCompletion";

export type PageStatusMode = "translation" | "inpainting";
export type PageListFilter =
  | "all"
  | "running"
  | "failed"
  | "pending"
  | "completed";

export type PageDisplayStatus =
  | "completed"
  | "translation-complete"
  | "running"
  | "failed"
  | "pending";

export function resolvePageDisplayStatus(
  page: MangaPage,
  statusMode: PageStatusMode,
): PageDisplayStatus {
  if (statusMode === "inpainting") {
    return page.inpaintedImagePath ? "completed" : "pending";
  }
  if (
    page.analysisStatus === "failed" ||
    page.translationCompletion?.status === "failed"
  ) {
    return "failed";
  }
  if (isPageFullyCompleted(page)) return "completed";
  if (page.analysisStatus === "running") return "running";
  if (page.analysisStatus !== "completed") return "pending";
  return "translation-complete";
}

export function matchesPageFilter(
  page: MangaPage,
  filter: PageListFilter,
  statusMode: PageStatusMode,
): boolean {
  if (filter === "all") return true;
  const status = resolvePageDisplayStatus(page, statusMode);
  if (filter === "running") {
    return status === "running" || status === "translation-complete";
  }
  return status === filter;
}

export function resolvePageStatusLabel(
  page: MangaPage,
  statusMode: PageStatusMode,
  t: TFunction<"components">,
): string {
  if (statusMode === "inpainting") {
    return t(page.inpaintedImagePath ? "status.erased" : "status.waiting");
  }
  switch (resolvePageDisplayStatus(page, statusMode)) {
    case "translation-complete":
      return t("status.translationCompleted");
    case "completed":
      return t("status.completed");
    case "running":
      return t("status.inProgressShort");
    case "failed":
      return t("status.failed");
    default:
      return t("status.waiting");
  }
}
