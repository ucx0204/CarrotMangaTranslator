export type FluxMode = "normal" | "light";

export type FluxBackend =
  | "cuda-native"
  | "cuda-sm75-experimental"
  | "rocm-native"
  | "vulkan-native"
  | "zluda-native"
  | "metal-native"
  | "cpu-native";

export const DEFAULT_INPAINTING_MODEL = "qwen-image-2.1" as const;

export const INPAINTING_MODELS = [
  "flux-klein",
  "lama-manga",
  "aot-inpainting",
  "qwen-image-2.1",
] as const;

export type InpaintingModel = (typeof INPAINTING_MODELS)[number];
export type KoharuInpaintingModel = Extract<
  InpaintingModel,
  "lama-manga" | "aot-inpainting"
>;

export function usesRegionInpainting(
  model: InpaintingModel | "codex" | undefined,
): boolean {
  return model === "flux-klein" || model === "qwen-image-2.1";
}

export type KoharuInpaintingBackend =
  | "auto"
  | "cuda-native"
  | "rocm-native"
  | "zluda-native"
  | "metal-native"
  | "cpu";
