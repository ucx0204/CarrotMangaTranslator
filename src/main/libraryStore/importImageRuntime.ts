import { nativeImage } from "electron";
import { getAppPaths } from "../appPaths";
import { decodeImageThroughRuntime } from "../simplePageRuntime";

type ImportImageMetadata = {
  width: number;
  height: number;
  isEmpty: boolean;
};

export type ImportImageRuntime = {
  decodeToPng: (sourcePath: string) => Promise<Buffer | null>;
  inspectImage: (imagePath: string) => ImportImageMetadata;
};

function createProductionImportImageRuntime(): ImportImageRuntime {
  return {
    decodeToPng: (sourcePath) =>
      decodeImageThroughRuntime(getAppPaths().runtimeDir, sourcePath),
    inspectImage: (imagePath) => {
      const image = nativeImage.createFromPath(imagePath);
      const size = image.getSize();
      return {
        width: size.width,
        height: size.height,
        isEmpty: typeof image.isEmpty === "function" ? image.isEmpty() : false,
      };
    },
  };
}

export const productionImportImageRuntime =
  createProductionImportImageRuntime();
