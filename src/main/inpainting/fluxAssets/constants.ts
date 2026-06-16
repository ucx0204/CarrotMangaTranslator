import { join } from "node:path";

export const FLUX_RUNTIME_EXECUTABLE = "mgt-flux-klein.exe";

export const FLUX_MODEL_REPO = "unsloth/FLUX.2-klein-4B-GGUF";

export const FLUX_MODEL_FILE = "flux-2-klein-4b-Q4_K_M.gguf";

export const FLUX_VAE_REPO = "black-forest-labs/FLUX.2-small-decoder";

export const FLUX_VAE_FILE = "diffusion_pytorch_model.safetensors";

export const FLUX_RUNNER_DIR = "mgt-flux-klein";

export const FLUX_CUDA_RUNTIME_DIR = "mgt-flux-cuda12.9";

export const FLUX_ZLUDA_SUPPORT_RUNTIME_DIR = "mgt-flux-zluda-support";

export const FLUX_CUDA_RUNTIME_MARKER = ".mgt-runtime.json";

export const FLUX_PYTHON_WORKER = "flux-klein-python-worker.py";

export const FLUX_SDCPP_WORKER = "flux-klein-sdcpp-worker.py";

export const FLUX_PYTHON_RUNTIME_MARKER = ".mgt-flux-python-runtime.json";

export const FLUX_ROCM_PREBUILT_RUNTIME_SCHEMA = 1;

export const WINDOWS_MSVC_COMPILER_TARGET = "x86_64-pc-windows-msvc";

export const WINDOWS_DYNAMIC_RUNTIME_LIB_NAMES = [
  "msvcrt.lib",
  "msvcprt.lib",
  "vcruntime.lib",
  "ucrt.lib",
  "oldnames.lib",
];

export const DEFAULT_AMD_GPU_TARGETS = [
  // Keep this in sync with scripts/build-flux-rocm-runtime.cjs. ROCm/HIP wants
  // concrete LLVM targets here, not grouped labels such as "gfx110X".
  "gfx908",
  "gfx90a",
  "gfx1030",
  "gfx1031",
  "gfx1032",
  "gfx1033",
  "gfx1034",
  "gfx1035",
  "gfx1036",
  "gfx1100",
  "gfx1101",
  "gfx1102",
  "gfx1103",
  "gfx1150",
  "gfx1151",
  "gfx1152",
  "gfx1153",
  "gfx1200",
  "gfx1201",
];

export const WINDOWS_SYSTEM_IMPORT_LIB_NAMES = [
  "kernel32.lib",
  "user32.lib",
  "gdi32.lib",
  "winspool.lib",
  "shell32.lib",
  "ole32.lib",
  "oleaut32.lib",
  "uuid.lib",
  "comdlg32.lib",
  "advapi32.lib",
];

export const FLUX_ROCM_PREBUILT_RUNTIME_MANIFEST = "mgt-flux-rocm-runtime.json";

export const FLUX_DIFFUSERS_MODEL_ID = "black-forest-labs/FLUX.2-klein-4B";

export const FLUX_SDCPP_VAE_FILE = "full_encoder_small_decoder.safetensors";

export const FLUX_SDCPP_LLM_REPO = "unsloth/Qwen3-4B-GGUF";

export const FLUX_SDCPP_LLM_FILE = "Qwen3-4B-Q4_K_M.gguf";

export const FLUX_ROCM_WINDOWS_VERSION = "7.2.1";

export const FLUX_CPU_TORCH_INDEX_URL = "https://download.pytorch.org/whl/cpu";

export const FLUX_PYTHON_DEFAULT_MODE = "klein-edit-composite";

export const FLUX_EMBED_PYTHON_VERSION = "3.12.7";

export const FLUX_ROCM_PREBUILT_RUNTIME_FILE = `mgt-flux-rocm-win-x64-rocm${FLUX_ROCM_WINDOWS_VERSION}-py${FLUX_EMBED_PYTHON_VERSION}-sdcpp.zip`;

export const FLUX_ROCM_PREBUILT_RUNTIME_URL = `https://github.com/ucx0204/CarrotMangaTranslator/releases/download/flux-runtime/${FLUX_ROCM_PREBUILT_RUNTIME_FILE}`;

export const FLUX_GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py";

export const FLUX_BOOTSTRAP_PYTHON_MARKER = ".mgt-flux-bootstrap-python.json";

export const WINDOWS_LEGACY_MAX_PATH = 260;

export const WINDOWS_PATH_SAFETY_MARGIN = 8;

export const ROCM_LONGEST_LIBRARY_ENTRY = join(
  "_rocm_sdk_libraries_custom",
  "bin",
  "hipblaslt",
  "library",
  "TensileLibrary_B8B8_B8B8_HA_Bias_SAB_SCD_SAV_UA_Type_B8B8_HPA_Contraction_l_Ailk_Bjlk_Cijk_Dijk_gfx1200.co",
);

export const ROCM_LONGEST_FINAL_ENTRY = join("p", ROCM_LONGEST_LIBRARY_ENTRY);

export const ROCM_LONGEST_PIP_TEMP_ENTRY = join(
  "t",
  "pip-target-xxxxxxxx",
  "lib",
  "python",
  ROCM_LONGEST_LIBRARY_ENTRY,
);

export const CUDA_REDIST_BASE_URL =
  "https://developer.download.nvidia.com/compute/cuda/redist";

export const CUDNN_REDIST_BASE_URL =
  "https://developer.download.nvidia.com/compute/cudnn/redist";

export const CUDA_REDIST_MANIFEST_URL = `${CUDA_REDIST_BASE_URL}/redistrib_12.9.0.json`;

export const CUDNN_REDIST_MANIFEST_URL = `${CUDNN_REDIST_BASE_URL}/redistrib_9.21.0.json`;

export const FLUX_CUDA_DLLS = new Set([
  "cublas64_12.dll",
  "cublasLt64_12.dll",
  "cudart64_12.dll",
  "curand64_10.dll",
]);

export const FLUX_ZLUDA_SUPPORT_DLLS = new Set(["curand64_10.dll"]);

export const FLUX_CUDNN_DLLS = new Set([
  "cudnn64_9.dll",
  "cudnn_adv64_9.dll",
  "cudnn_cnn64_9.dll",
  "cudnn_engines_precompiled64_9.dll",
  "cudnn_engines_runtime_compiled64_9.dll",
  "cudnn_engines_tensor_ir64_9.dll",
  "cudnn_graph64_9.dll",
  "cudnn_heuristic64_9.dll",
  "cudnn_ops64_9.dll",
]);

export function resolveFluxRuntimeTempDir(runtimeDir: string): string {
  return join(runtimeDir, "t");
}
