import type {
  PageExportSelectionRequest,
  PageImageExportFormat,
} from "../../shared/pageImageExportTypes";

export type PageImageExportWriteOptions = {
  collisionPolicy: "replace" | "skip" | "cancel";
  destinationMode: "timestamped" | "fixed";
  jpegQuality: number;
  omitText: boolean;
  outputFormat: PageImageExportFormat | "psd";
  preserveSourceNames: boolean;
  webpQuality: number;
};

export function resolvePageImageExportWriteOptions(
  request: PageExportSelectionRequest,
): PageImageExportWriteOptions {
  const isPsd = request.outputFormat === "psd";
  return {
    collisionPolicy: request.collisionPolicy ?? "replace",
    destinationMode:
      !isPsd && request.destinationMode
        ? request.destinationMode
        : "timestamped",
    jpegQuality: !isPsd ? (request.jpegQuality ?? 95) : 95,
    omitText: request.omitText === true,
    outputFormat: request.outputFormat ?? "png",
    preserveSourceNames: !isPsd ? (request.preserveSourceNames ?? true) : false,
    webpQuality: !isPsd ? (request.webpQuality ?? 90) : 90,
  };
}
