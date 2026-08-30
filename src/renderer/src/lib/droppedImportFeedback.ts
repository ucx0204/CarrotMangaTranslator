import type { TFunction } from "i18next";
import type { DroppedImportPreviewResponse } from "../../../shared/importTypes";

type DroppedImportRejection = Extract<
  DroppedImportPreviewResponse,
  { status: "rejected" }
>;

export function resolveDroppedImportRejectionMessage(
  rejection: DroppedImportRejection,
  t: TFunction<"renderer">,
  maxItems: number,
): string {
  if (rejection.reason === "pdf-must-be-alone") {
    return t("import.drop.pdfMustBeAlone");
  }
  if (rejection.reason === "pdf-no-pages") {
    return t("import.drop.pdfNoPages");
  }
  return resolveNonPdfDroppedImportRejectionMessage(rejection, t, maxItems);
}

function resolveNonPdfDroppedImportRejectionMessage(
  rejection: DroppedImportRejection,
  t: TFunction<"renderer">,
  maxItems: number,
): string {
  switch (rejection.reason) {
    case "cancelled":
      return t("import.cancelled");
    case "busy":
      return t("import.drop.unavailable");
    case "empty":
      return t("import.drop.empty");
    case "too-many-items":
      return t("import.drop.tooManyItems", { max: maxItems });
    case "folder-must-be-alone":
      return t("import.drop.folderMustBeAlone");
    case "archive-must-be-alone":
      return t("import.drop.archiveMustBeAlone");
    case "unsupported-files": {
      const names = rejection.names?.slice(0, 2).join(", ");
      return names
        ? t("import.drop.unsupportedFilesNamed", { names })
        : t("import.drop.unsupportedFiles");
    }
    case "folder-no-images":
      return t("import.drop.folderNoImages");
    case "archive-no-images":
      return t("import.drop.archiveNoImages");
    default:
      throw new Error(`Unexpected PDF rejection: ${rejection.reason}`);
  }
}
