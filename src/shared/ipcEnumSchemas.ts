import { z } from "zod";

export const GemmaVramModeSchema = z.preprocess(
  (value) => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (
      ["minimum12b", "minimum", "minimal", "min", "12b"].includes(normalized)
    ) {
      return "minimum12b";
    }
    if (["economy26b", "economy", "eco", "26b"].includes(normalized)) {
      return "economy26b";
    }
    if (["full31b", "full", "31b"].includes(normalized)) {
      return "full31b";
    }
    return value;
  },
  z.enum(["minimum12b", "economy26b", "full31b"]),
);

export const LlamaRuntimeProfileSchema = z.preprocess(
  (value) => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (
      ["rtx50", "blackwell", "cuda13", "cuda13.1", "cuda13.3"].includes(
        normalized,
      )
    ) {
      return "rtx50";
    }
    if (["cuda12", "cuda12.4", "cuda"].includes(normalized)) {
      return "cuda12";
    }
    if (["rocm", "hip", "amd-rocm"].includes(normalized)) {
      return "rocm";
    }
    if (["vulkan", "amd-vulkan", "vk"].includes(normalized)) {
      return "vulkan";
    }
    if (["metal", "apple", "apple-metal", "mps"].includes(normalized)) {
      return "metal";
    }
    return value;
  },
  z.enum(["cuda12", "rtx50", "rocm", "vulkan", "metal"]),
);

export const AmdRocmTargetSchema = z.preprocess(
  (value) => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[-_\s]/g, "");
    if (normalized === "gfx908") {
      return "gfx908";
    }
    if (normalized === "gfx90a") {
      return "gfx90a";
    }
    if (/^gfx103[0-9a-fx]*$/.test(normalized)) {
      return "gfx103X";
    }
    if (/^gfx110[0-9a-fx]*$/.test(normalized)) {
      return "gfx110X";
    }
    if (normalized === "gfx1150") {
      return "gfx1150";
    }
    if (normalized === "gfx1151") {
      return "gfx1151";
    }
    if (/^gfx120[0-9a-fx]*$/.test(normalized)) {
      return "gfx120X";
    }
    return value;
  },
  z.enum([
    "gfx908",
    "gfx90a",
    "gfx103X",
    "gfx110X",
    "gfx1150",
    "gfx1151",
    "gfx120X",
  ]),
);

export const FluxBackendSchema = z.preprocess(
  (value) => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (["auto", ""].includes(normalized)) {
      return "cuda-native";
    }
    if (["cuda-native", "cuda", "native", "nvidia"].includes(normalized)) {
      return "cuda-native";
    }
    if (["zluda-native", "zluda"].includes(normalized)) {
      return "zluda-native";
    }
    if (
      ["metal-native", "metal", "apple", "apple-metal", "mps"].includes(
        normalized,
      )
    ) {
      return "metal-native";
    }
    if (["python-rocm", "rocm", "hip", "amd"].includes(normalized)) {
      return "zluda-native";
    }
    if (["python-cpu", "cpu"].includes(normalized)) {
      return "python-cpu";
    }
    return value;
  },
  z.enum(["cuda-native", "zluda-native", "metal-native", "python-cpu"]),
);

export const InpaintingModelSchema = z.preprocess(
  (value) => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (
      ["", "auto", "flux", "flux-klein", "klein", "default"].includes(
        normalized,
      )
    ) {
      return "flux-klein";
    }
    if (["koharu", "lama", "lama-manga", "lama_manga"].includes(normalized)) {
      return "lama-manga";
    }
    if (["aot", "aot-inpainting", "aot_inpainting"].includes(normalized)) {
      return "aot-inpainting";
    }
    return value;
  },
  z.enum(["flux-klein", "lama-manga", "aot-inpainting"]),
);

export const KoharuInpaintingBackendSchema = z.preprocess(
  (value) => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (["", "auto", "default"].includes(normalized)) {
      return "auto";
    }
    if (["cuda", "cuda-native", "nvidia"].includes(normalized)) {
      return "cuda-native";
    }
    if (["zluda", "zluda-native", "amd"].includes(normalized)) {
      return "zluda-native";
    }
    if (
      ["metal", "metal-native", "apple", "apple-metal", "mps"].includes(
        normalized,
      )
    ) {
      return "metal-native";
    }
    if (["cpu", "python-cpu"].includes(normalized)) {
      return "cpu";
    }
    return value;
  },
  z.enum(["auto", "cuda-native", "zluda-native", "metal-native", "cpu"]),
);

export const OcrGpuBackendSchema = z.preprocess(
  (value) => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (["auto", "", "cuda", "nvidia"].includes(normalized)) {
      return "cuda";
    }
    if (
      ["rocm", "amd", "hip", "rocm-transformers", "transformers-rocm"].includes(
        normalized,
      )
    ) {
      return "rocm-transformers";
    }
    return value;
  },
  z.enum(["cuda", "rocm-transformers"]),
);

export const OcrQualityModeSchema = z.preprocess(
  (value) => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (
      [
        "minimum",
        "minimal",
        "min",
        "tiny",
        "tiny_rec",
        "tiny-rec",
        "12b",
        "최소",
      ].includes(normalized)
    ) {
      return "minimum";
    }
    if (
      [
        "economy",
        "eco",
        "small",
        "small_rec",
        "small-rec",
        "26b",
        "절약",
      ].includes(normalized)
    ) {
      return "economy";
    }
    if (["full", "quality", "31b", "풀로드"].includes(normalized)) {
      return "full";
    }
    if (
      [
        "cuda-legacy-full",
        "cuda_legacy_full",
        "cuda-legacy",
        "legacy-full",
        "legacy",
        "vl",
        "paddleocr-vl",
        "cuda 레거시 풀로드",
      ].includes(normalized)
    ) {
      return "cuda-legacy-full";
    }
    return value;
  },
  z.enum(["minimum", "economy", "full", "cuda-legacy-full"]),
);
