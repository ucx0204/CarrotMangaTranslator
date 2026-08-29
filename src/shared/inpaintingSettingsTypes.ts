export type FluxBackend =
  | "cuda-native"
  | "cuda-sm75-experimental"
  | "zluda-native"
  | "metal-native"
  | "cpu-native";

export type InpaintingModel = "flux-klein" | "lama-manga" | "aot-inpainting";

export type KoharuInpaintingBackend =
  | "auto"
  | "cuda-native"
  | "zluda-native"
  | "metal-native"
  | "cpu";
