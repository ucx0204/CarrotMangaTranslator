import { getAppPaths } from "../appPaths";
import {
  convertImageToPngFileThroughRuntime,
  validateImageThroughRuntime,
  type RuntimeImageConversionOptions,
  type RuntimeImageValidationOptions,
} from "../simplePageRuntime";

export type ImportImageValidationOptions = Omit<
  RuntimeImageValidationOptions,
  "abortSignal"
> & {
  signal?: AbortSignal;
};

export type ImportImageConversionOptions = Omit<
  RuntimeImageConversionOptions,
  "abortSignal"
> & {
  signal?: AbortSignal;
};

export type ImportImageRuntime = {
  validateImageFile: (
    imagePath: string,
    options: ImportImageValidationOptions,
  ) => Promise<void>;
  convertWebpToPngFile: (
    sourcePath: string,
    outputPath: string,
    options: ImportImageConversionOptions,
  ) => Promise<void>;
};

function createProductionImportImageRuntime(): ImportImageRuntime {
  return {
    validateImageFile: (imagePath, options) =>
      validateImageThroughRuntime(getAppPaths().runtimeDir, imagePath, options),
    convertWebpToPngFile: (sourcePath, outputPath, options) =>
      convertImageToPngFileThroughRuntime(
        getAppPaths().runtimeDir,
        sourcePath,
        outputPath,
        options,
      ),
  };
}

export const productionImportImageRuntime =
  createProductionImportImageRuntime();
