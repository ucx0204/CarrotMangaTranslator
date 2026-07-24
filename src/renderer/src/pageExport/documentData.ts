import {
  PageExportDocumentDataSchema,
  type PageExportDocumentData,
} from "../../../shared/pageExportContracts";

export function parsePageExportData(
  element: HTMLElement | null,
): PageExportDocumentData {
  if (!element) {
    throw new Error("Page export data element is missing.");
  }
  const parsed: unknown = JSON.parse(element.textContent ?? "");
  const result = PageExportDocumentDataSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("Page export data has an invalid shape.", {
      cause: result.error,
    });
  }
  return result.data;
}
