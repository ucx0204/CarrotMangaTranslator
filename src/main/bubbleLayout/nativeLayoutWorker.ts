import { serveInference } from "../runtimeSupport/inferenceUtilityHost";
import { KOHARU_LAYOUT_INPUT_SIZE } from "./constants";
import { convertBgraBitmapToRgbChw } from "./preprocess";
import { inferNativeLayout } from "./nativeDetector";
import type { NativeLayoutRequest } from "./contracts";

serveInference(({ bitmap, width, height, ...options }: NativeLayoutRequest) =>
  inferNativeLayout(
    {
      imageWidth: width,
      imageHeight: height,
      rgbChw: convertBgraBitmapToRgbChw(
        bitmap,
        width,
        height,
        undefined,
        KOHARU_LAYOUT_INPUT_SIZE,
      ),
    },
    options,
  ),
);
