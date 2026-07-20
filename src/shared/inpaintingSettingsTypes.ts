export type FluxBackend =
  | "cuda-native"
  | "zluda-native"
  | "metal-native"
  | "python-cpu";

export type InpaintingModel = "flux-klein" | "lama-manga" | "aot-inpainting";

export type BubbleDetectionMode = "auto" | "precise";

export type KoharuInpaintingBackend =
  | "auto"
  | "cuda-native"
  | "zluda-native"
  | "metal-native"
  | "cpu";
