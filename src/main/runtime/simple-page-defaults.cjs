// @ts-check
const { runtimeOverrideEnv } = require("./simple-page-child-env.cjs");

const DEFAULT_MODEL_HF =
  "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-i1-GGUF";
const DEFAULT_HF_FILE =
  "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.i1-IQ3_S.gguf";
const DEFAULT_MMPROJ_HF =
  "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-GGUF";
const DEFAULT_MMPROJ_FILE =
  "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.mmproj-f16.gguf";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CODEX_REASONING_EFFORT = "low";
const DEFAULT_API_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_API_MODEL = DEFAULT_CODEX_MODEL;
const DEFAULT_API_KEY = "local-llama-server";
const DEFAULT_API_TEMPERATURE = 0.2;
const DEFAULT_API_TOP_P = 0.95;
const DEFAULT_API_TOP_K = null;
const DEFAULT_API_REASONING_EFFORT = null;
const DEFAULT_API_EXTRA_BODY_JSON = "";
const DEFAULT_API_CUSTOM_HEADERS_JSON = "";
const DEFAULT_OCR_CPU_PIP_PACKAGES = [
  "paddlepaddle==3.3.1",
  "paddleocr[doc-parser]==3.7.0",
];
const DEFAULT_OCR_GPU_PADDLE_PACKAGE = "paddlepaddle-gpu==3.3.1";
const DEFAULT_OCR_GPU_EXTRA_PACKAGES = ["paddleocr[doc-parser]==3.7.0"];
const DEFAULT_OCR_GPU_CUDA_TAG = "cu126";
const AMD_ROCM_721_SDK_WHEEL_PACKAGES = [
  "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_core-7.2.1-py3-none-win_amd64.whl",
  "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl",
  "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl",
];
const AMD_ROCM_721_META_PACKAGES = [
  "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm-7.2.1.tar.gz",
];
const AMD_ROCM_721_SDK_PACKAGES = [
  ...AMD_ROCM_721_SDK_WHEEL_PACKAGES,
  ...AMD_ROCM_721_META_PACKAGES,
];
const AMD_ROCM_721_TORCH_PACKAGES = [
  "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
  "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchaudio-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
  "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchvision-0.24.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
];
const AMD_ROCM_721_TORCH_DEP_PACKAGES = [
  "filelock",
  "typing-extensions>=4.10.0",
  "setuptools",
  "sympy>=1.13.3",
  "networkx>=2.5.1",
  "jinja2",
  "fsspec>=0.8.5",
  "numpy",
  "pillow",
];
const DEFAULT_OCR_AMD_TRANSFORMERS_PACKAGES = [
  "paddleocr==3.7.0",
  "transformers>=5.10.0",
  "safetensors>=0.6.2",
];
const PADDLEOCR_VL_WINDOWS_SAFETENSORS_WHEEL =
  "https://xly-devops.cdn.bcebos.com/safetensors-nightly/safetensors-0.6.2.dev0-cp38-abi3-win_amd64.whl";
const OCR_INSTALL_MARKER_FILE = "install-complete.json";
const MAX_LOG_PREVIEW_LENGTH = 8000;
const MM_PROJ_CANDIDATE_NAMES = [
  "mmproj-BF16.gguf",
  "mmproj-F16.gguf",
  "mmproj-F32.gguf",
  "mmproj.gguf",
];
const DEFAULT_OCR_BBOX_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_OCR_BBOX_PAGE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_DOWNLOAD_METADATA_TIMEOUT_MS = 30000;
const DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_DOWNLOAD_RETRY_COUNT = 3;
const HF_DOWNLOAD_CHUNK_SIZE = 10 * 1024 * 1024;
const CROP_RETRY_MIN_SIDE_PX = 192;
const CROP_RETRY_MIN_MARGIN_PX = 64;
const CROP_RETRY_MARGIN_RATIO = 0.5;
const PADDLE_OCR_MODEL_DOWNLOADS = [
  {
    name: "PP-DocLayoutV3",
    repo: "PaddlePaddle/PP-DocLayoutV3",
    files: [
      ".gitattributes",
      "README.md",
      "inference.json",
      "inference.pdiparams",
      "inference.yml",
    ],
  },
  {
    name: "PaddleOCR-VL-1.6",
    repo: "PaddlePaddle/PaddleOCR-VL-1.6",
    files: [
      ".gitattributes",
      "LICENSE",
      "README.md",
      "added_tokens.json",
      "chat_template.jinja",
      "config.json",
      "configuration_paddleocr_vl.py",
      "generation_config.json",
      "image_processing_paddleocr_vl.py",
      "inference.yml",
      "model.safetensors",
      "modeling_paddleocr_vl.py",
      "preprocessor_config.json",
      "processing_paddleocr_vl.py",
      "processor_config.json",
      "special_tokens_map.json",
      "tokenizer.json",
      "tokenizer.model",
      "tokenizer_config.json",
    ],
  },
  {
    name: "PP-OCRv6_medium_det",
    repo: "PaddlePaddle/PP-OCRv6_medium_det",
    files: [
      ".gitattributes",
      "README.md",
      "inference.json",
      "inference.pdiparams",
      "inference.yml",
    ],
  },
  {
    name: "PP-OCRv6_medium_rec",
    repo: "PaddlePaddle/PP-OCRv6_medium_rec",
    files: [
      ".gitattributes",
      "README.md",
      "inference.json",
      "inference.pdiparams",
      "inference.yml",
    ],
  },
];

function resolveAmdRocmSdkPackages(options = {}) {
  if (
    isTruthy(
      runtimeOverrideEnv(
        "MANGA_TRANSLATOR_OCR_ROCM_SKIP_META_PACKAGE",
        options,
      ),
    )
  ) {
    return AMD_ROCM_721_SDK_PACKAGES.filter(
      (item) => !isAmdRocmMetaPackage(item),
    );
  }
  return AMD_ROCM_721_SDK_PACKAGES;
}

function resolveAmdRocmSdkWheelPackages(options = {}) {
  return resolveAmdRocmSdkPackages(options).filter(
    (item) => !isAmdRocmMetaPackage(item),
  );
}

function resolveAmdRocmMetaPackage(options = {}) {
  return resolveAmdRocmSdkPackages(options).filter(isAmdRocmMetaPackage);
}

function isAmdRocmMetaPackage(item) {
  return /(?:^|[/\\])rocm-\d+(?:\.\d+)*\.tar\.gz(?:[?#].*)?$/i.test(
    String(item ?? ""),
  );
}

function isTruthy(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(text);
}

module.exports = {
  AMD_ROCM_721_META_PACKAGES,
  AMD_ROCM_721_SDK_PACKAGES,
  AMD_ROCM_721_SDK_WHEEL_PACKAGES,
  AMD_ROCM_721_TORCH_DEP_PACKAGES,
  AMD_ROCM_721_TORCH_PACKAGES,
  CROP_RETRY_MARGIN_RATIO,
  CROP_RETRY_MIN_MARGIN_PX,
  CROP_RETRY_MIN_SIDE_PX,
  DEFAULT_OCR_AMD_TRANSFORMERS_PACKAGES,
  DEFAULT_API_KEY,
  DEFAULT_API_BASE_URL,
  DEFAULT_API_CUSTOM_HEADERS_JSON,
  DEFAULT_API_EXTRA_BODY_JSON,
  DEFAULT_API_MODEL,
  DEFAULT_API_REASONING_EFFORT,
  DEFAULT_API_TEMPERATURE,
  DEFAULT_API_TOP_K,
  DEFAULT_API_TOP_P,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_DOWNLOAD_METADATA_TIMEOUT_MS,
  DEFAULT_DOWNLOAD_RETRY_COUNT,
  DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS,
  DEFAULT_HF_FILE,
  DEFAULT_MMPROJ_FILE,
  DEFAULT_MMPROJ_HF,
  DEFAULT_MODEL_HF,
  DEFAULT_OCR_BBOX_PAGE_TIMEOUT_MS,
  DEFAULT_OCR_BBOX_TIMEOUT_MS,
  DEFAULT_OCR_CPU_PIP_PACKAGES,
  DEFAULT_OCR_GPU_CUDA_TAG,
  DEFAULT_OCR_GPU_EXTRA_PACKAGES,
  DEFAULT_OCR_GPU_PADDLE_PACKAGE,
  HF_DOWNLOAD_CHUNK_SIZE,
  MAX_LOG_PREVIEW_LENGTH,
  MM_PROJ_CANDIDATE_NAMES,
  OCR_INSTALL_MARKER_FILE,
  PADDLE_OCR_MODEL_DOWNLOADS,
  PADDLEOCR_VL_WINDOWS_SAFETENSORS_WHEEL,
  resolveAmdRocmMetaPackage,
  resolveAmdRocmSdkPackages,
  resolveAmdRocmSdkWheelPackages,
};
