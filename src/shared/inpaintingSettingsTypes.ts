export type FluxBackend = "cuda-native" | "zluda-native" | "python-cpu";

export type InpaintingModel = "flux-klein" | "lama-manga" | "aot-inpainting";

export type KoharuInpaintingBackend =
  | "auto"
  | "cuda-native"
  | "zluda-native"
  | "cpu";
