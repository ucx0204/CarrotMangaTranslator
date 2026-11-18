export type FluxMode = "normal" | "light";

export type FluxBackend =
  | "cuda-native"
  | "cuda-sm75-experimental"
  | "rocm-native"
  | "vulkan-native"
  | "zluda-native"
  | "metal-native"
  | "cpu-native";

export type InpaintingModel = "flux-klein" | "lama-manga" | "aot-inpainting";

export type KoharuInpaintingBackend =
  | "auto"
  | "cuda-native"
  | "rocm-native"
  | "zluda-native"
  | "metal-native"
  | "cpu";
