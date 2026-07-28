export const COMIC_BUBBLE_DETECTOR_REPO =
  "ogkalu/comic-text-and-bubble-detector";
export const COMIC_BUBBLE_DETECTOR_REVISION =
  "16e8a622f91fabc6b5b65c96d32d1183f8843546";
export const COMIC_BUBBLE_DETECTOR_FILE = "detector-v4-s_int8.onnx";
export const COMIC_BUBBLE_DETECTOR_SHA256 =
  "5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79";
export const COMIC_BUBBLE_DETECTOR_BYTES = 11_120_765;
export const COMIC_BUBBLE_DETECTOR_INPUT_SIZE = 640;
export const DEFAULT_COMIC_DETECTION_SCORE_THRESHOLD = 0.35;

export const COMIC_DETECTION_LABELS = [
  "bubble",
  "text_bubble",
  "text_free",
] as const;
